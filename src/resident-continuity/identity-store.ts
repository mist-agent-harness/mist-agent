/**
 * D22 zero-project identity registry.
 *
 * The whole candidate -> resident transition lives in one atomically replaced
 * registry file.  Readers therefore see either the inactive candidate or the
 * complete active resident (including its first persona version), never a
 * half-activated identity assembled from two stores.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Actor,
  CandidateSnapshot,
  ContinuityVerdict,
  PersonaVersion,
  ResidentSnapshot,
} from "../../acceptance/resident-continuity-driver.ts";

const IDENTITY_SCHEMA_VERSION = 1;

interface CandidateRecord {
  candidateId: string;
  state: CandidateSnapshot["state"];
  residentId: string | null;
  persona: string;
  personaVersionId: string;
  proposedBy: Actor;
  requestedResidentId: string | null;
}

interface ResidentRecord {
  residentId: string;
  candidateId: string;
  active: boolean;
  persona: PersonaVersion[];
  memories: string[];
  scopeIds: string[];
  grantIds: string[];
}

interface IdentityRegistryRecord {
  readonly schemaVersion: typeof IDENTITY_SCHEMA_VERSION;
  readonly candidates: CandidateRecord[];
  readonly residents: ResidentRecord[];
}

export type ResidentIdentityFailureReason =
  | "candidate-not-found"
  | "candidate-attestation-forbidden"
  | "candidate-finalized"
  | "candidate-pending"
  | "candidate-rejected"
  | "resident-not-found";

export type ResidentIdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ResidentIdentityFailureReason };

export interface ActiveResidentIdentity {
  readonly candidateId: string;
  readonly residentId: string;
  readonly personaVersionId: string;
  readonly persona: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fail<T>(reason: ResidentIdentityFailureReason): ResidentIdentityResult<T> {
  return { ok: false, reason };
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function emptyRegistry(): IdentityRegistryRecord {
  return { schemaVersion: IDENTITY_SCHEMA_VERSION, candidates: [], residents: [] };
}

function assertRegistry(record: IdentityRegistryRecord): void {
  if (
    record.schemaVersion !== IDENTITY_SCHEMA_VERSION ||
    !Array.isArray(record.candidates) ||
    !Array.isArray(record.residents)
  ) {
    throw new Error("resident identity registry has an unsupported shape");
  }
  const candidateIds = new Set<string>();
  const residentIds = new Set<string>();
  for (const candidate of record.candidates) {
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(`duplicate candidate identity: ${candidate.candidateId}`);
    }
    candidateIds.add(candidate.candidateId);
    if (
      candidate.requestedResidentId !== null &&
      !/^[a-z0-9-]+$/.test(candidate.requestedResidentId)
    ) {
      throw new Error(`candidate ${candidate.candidateId} has an invalid requested resident id`);
    }
  }
  for (const resident of record.residents) {
    if (residentIds.has(resident.residentId)) {
      throw new Error(`duplicate resident identity: ${resident.residentId}`);
    }
    residentIds.add(resident.residentId);
    const candidate = record.candidates.find((entry) => entry.candidateId === resident.candidateId);
    if (
      candidate === undefined ||
      candidate.state !== "active" ||
      candidate.residentId !== resident.residentId
    ) {
      throw new Error(`resident identity ${resident.residentId} has no active candidate mapping`);
    }
  }
  for (const candidate of record.candidates) {
    if (candidate.state === "active" && !residentIds.has(candidate.residentId ?? "")) {
      throw new Error(`active candidate ${candidate.candidateId} has no resident record`);
    }
    if (candidate.state !== "active" && candidate.residentId !== null) {
      throw new Error(`inactive candidate ${candidate.candidateId} carries a resident id`);
    }
  }
}

export class ResidentIdentityStore {
  readonly #dataDir: string;
  readonly #registryPath: string;
  #registry: IdentityRegistryRecord;

  constructor(options: { dataDir: string }) {
    this.#dataDir = options.dataDir;
    this.#registryPath = join(options.dataDir, "registry.json");
    mkdirSync(this.#dataDir, { recursive: true, mode: 0o700 });
    try {
      const record = JSON.parse(readFileSync(this.#registryPath, "utf8")) as IdentityRegistryRecord;
      assertRegistry(record);
      this.#registry = record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#registry = emptyRegistry();
    }
  }

  createCandidate(input: {
    persona: string;
    proposedBy: Actor;
    residentId?: string;
  }): CandidateSnapshot {
    if (input.persona.length === 0) throw new Error("candidate persona must not be empty");
    if (input.residentId !== undefined && !/^[a-z0-9-]+$/.test(input.residentId)) {
      throw new Error(`requested resident id is invalid: ${input.residentId}`);
    }
    if (
      input.residentId !== undefined &&
      (this.#registry.residents.some((entry) => entry.residentId === input.residentId) ||
        this.#registry.candidates.some(
          (entry) => entry.state !== "rejected" && entry.requestedResidentId === input.residentId,
        ))
    ) {
      throw new Error(`requested resident id is already reserved: ${input.residentId}`);
    }
    const candidate: CandidateRecord = {
      candidateId: `candidate-${randomUUID()}`,
      state: "inactive",
      residentId: null,
      persona: input.persona,
      personaVersionId: `persona-${randomUUID()}`,
      proposedBy: clone(input.proposedBy),
      requestedResidentId: input.residentId ?? null,
    };
    const next = clone(this.#registry);
    next.candidates.push(candidate);
    this.#commit(next);
    return this.#candidateSnapshot(candidate);
  }

  attestCandidate(
    candidateId: string,
    actor: Actor,
    decision: ContinuityVerdict,
  ): ResidentIdentityResult<CandidateSnapshot> {
    const candidate = this.#registry.candidates.find((entry) => entry.candidateId === candidateId);
    if (candidate === undefined) return fail("candidate-not-found");
    if (actor.kind !== "candidate" || actor.candidateId !== candidateId) {
      return fail("candidate-attestation-forbidden");
    }
    if (candidate.state !== "inactive") return fail("candidate-finalized");

    const next = clone(this.#registry);
    const nextCandidate = next.candidates.find((entry) => entry.candidateId === candidateId);
    if (nextCandidate === undefined) throw new Error("candidate disappeared during attestation");
    if (decision === "rejected") {
      nextCandidate.state = "rejected";
      this.#commit(next);
      return { ok: true, value: this.#candidateSnapshot(nextCandidate) };
    }

    const residentId = nextCandidate.requestedResidentId ?? `resident-${randomUUID()}`;
    const firstPersona: PersonaVersion = {
      id: nextCandidate.personaVersionId,
      content: nextCandidate.persona,
      author: { kind: "candidate", candidateId },
      supersededBy: null,
    };
    const resident: ResidentRecord = {
      residentId,
      candidateId,
      active: true,
      persona: [firstPersona],
      memories: [],
      scopeIds: [],
      grantIds: [],
    };
    nextCandidate.state = "active";
    nextCandidate.residentId = residentId;
    next.residents.push(resident);
    this.#commit(next);
    return { ok: true, value: this.#candidateSnapshot(nextCandidate) };
  }

  inspectCandidate(candidateId: string): ResidentIdentityResult<CandidateSnapshot> {
    const candidate = this.#registry.candidates.find((entry) => entry.candidateId === candidateId);
    return candidate === undefined
      ? fail("candidate-not-found")
      : { ok: true, value: this.#candidateSnapshot(candidate) };
  }

  readCandidate(candidateId: string): CandidateSnapshot {
    const inspected = this.inspectCandidate(candidateId);
    if (!inspected.ok) throw new Error(inspected.reason);
    return inspected.value;
  }

  readResident(residentId: string): ResidentSnapshot {
    const resident = this.#registry.residents.find((entry) => entry.residentId === residentId);
    if (resident === undefined) throw new Error("resident-not-found");
    return this.#residentSnapshot(resident);
  }

  requireActiveResident(referenceId: string): ResidentIdentityResult<ActiveResidentIdentity> {
    let resident = this.#registry.residents.find((entry) => entry.residentId === referenceId);
    let candidate = this.#registry.candidates.find((entry) => entry.candidateId === referenceId);
    if (resident !== undefined) {
      candidate = this.#registry.candidates.find(
        (entry) => entry.candidateId === resident?.candidateId,
      );
    }
    if (candidate === undefined) return fail("resident-not-found");
    if (candidate.state === "inactive") return fail("candidate-pending");
    if (candidate.state === "rejected") return fail("candidate-rejected");
    resident ??= this.#registry.residents.find(
      (entry) => entry.residentId === candidate?.residentId,
    );
    if (resident === undefined || !resident.active) return fail("resident-not-found");
    const persona = resident.persona.find(
      (version) => version.id === candidate?.personaVersionId && version.supersededBy === null,
    );
    if (persona === undefined) throw new Error("active resident has no current candidate persona");
    return {
      ok: true,
      value: {
        candidateId: candidate.candidateId,
        residentId: resident.residentId,
        personaVersionId: persona.id,
        persona: persona.content,
      },
    };
  }

  /**
   * Runtime-internal gate: unlike the terminal/host reference resolver above, this accepts only
   * the canonical residentId. candidateId is an onboarding handle and must not become a second
   * runtime name for the same resident.
   */
  requireResident(residentId: string): ResidentIdentityResult<ActiveResidentIdentity> {
    const resident = this.#registry.residents.find((entry) => entry.residentId === residentId);
    if (resident === undefined || !resident.active) return fail("resident-not-found");
    const candidate = this.#registry.candidates.find(
      (entry) => entry.candidateId === resident.candidateId,
    );
    if (candidate === undefined || candidate.state !== "active") {
      return fail("resident-not-found");
    }
    const persona = resident.persona.find(
      (version) => version.id === candidate.personaVersionId && version.supersededBy === null,
    );
    if (persona === undefined) throw new Error("active resident has no current candidate persona");
    return {
      ok: true,
      value: {
        candidateId: candidate.candidateId,
        residentId: resident.residentId,
        personaVersionId: persona.id,
        persona: persona.content,
      },
    };
  }

  activeResidents(): ActiveResidentIdentity[] {
    return this.#registry.residents
      .filter((resident) => resident.active)
      .map((resident) => {
        const active = this.requireActiveResident(resident.residentId);
        if (!active.ok) {
          throw new Error(
            `active resident ${resident.residentId} failed identity recovery: ${active.reason}`,
          );
        }
        return active.value;
      });
  }

  #candidateSnapshot(candidate: CandidateRecord): CandidateSnapshot {
    const {
      proposedBy: _proposedBy,
      requestedResidentId: _requestedResidentId,
      ...snapshot
    } = candidate;
    return clone(snapshot);
  }

  #residentSnapshot(resident: ResidentRecord): ResidentSnapshot {
    const { candidateId: _candidateId, ...snapshot } = resident;
    return clone(snapshot);
  }

  #commit(next: IdentityRegistryRecord): void {
    assertRegistry(next);
    const temporaryPath = `${this.#registryPath}.tmp-${process.pid}-${randomUUID()}`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      fchmodSync(descriptor, 0o600);
      writeSync(descriptor, JSON.stringify(next));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, this.#registryPath);
      fsyncDirectory(this.#dataDir);
      this.#registry = next;
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the write failure that made the transition abort.
        }
      }
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}
