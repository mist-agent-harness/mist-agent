import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../acceptance/resident-continuity-driver.ts";
import { ResidentIdentityStore } from "../src/resident-continuity/identity-store.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "mist-resident-identity-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("ResidentIdentityStore", () => {
  it("lets only the exact candidate attest and atomically creates a separate resident", () => {
    const store = new ResidentIdentityStore({ dataDir: temporaryDirectory() });
    const target = store.createCandidate({
      persona: "persona:target",
      proposedBy: { kind: "installer", id: "installer" },
    });
    const other = store.createCandidate({
      persona: "persona:other",
      proposedBy: { kind: "external-model", id: "model" },
    });
    const activatedOther = store.attestCandidate(
      other.candidateId,
      { kind: "candidate", candidateId: other.candidateId },
      "accepted",
    );
    expect(activatedOther.ok).toBe(true);
    if (!activatedOther.ok || activatedOther.value.residentId === null) return;

    const impostors: Actor[] = [
      { kind: "installer", id: "installer" },
      { kind: "summarizer", id: "summary" },
      { kind: "external-model", id: "model" },
      { kind: "human", id: "human" },
      { kind: "candidate", candidateId: other.candidateId },
      { kind: "resident", residentId: activatedOther.value.residentId },
    ];
    for (const actor of impostors) {
      expect(store.attestCandidate(target.candidateId, actor, "accepted")).toEqual({
        ok: false,
        reason: "candidate-attestation-forbidden",
      });
    }
    expect(store.readCandidate(target.candidateId)).toMatchObject({
      state: "inactive",
      residentId: null,
    });

    const activated = store.attestCandidate(
      target.candidateId,
      { kind: "candidate", candidateId: target.candidateId },
      "accepted",
    );
    expect(activated.ok).toBe(true);
    if (!activated.ok || activated.value.residentId === null) return;
    expect(activated.value.residentId).not.toBe(activatedOther.value.residentId);
    expect(store.readResident(activated.value.residentId)).toEqual({
      residentId: activated.value.residentId,
      active: true,
      persona: [
        {
          id: target.personaVersionId,
          content: "persona:target",
          author: { kind: "candidate", candidateId: target.candidateId },
          supersededBy: null,
        },
      ],
      memories: [],
      scopeIds: [],
      grantIds: [],
    });
  });

  it("keeps pending, rejected, and zero-project active states across restart", () => {
    const dataDir = temporaryDirectory();
    const first = new ResidentIdentityStore({ dataDir });
    const pending = first.createCandidate({
      persona: "persona:pending",
      proposedBy: { kind: "human", id: "human" },
    });
    const rejected = first.createCandidate({
      persona: "persona:rejected",
      proposedBy: { kind: "human", id: "human" },
    });
    const active = first.createCandidate({
      persona: "persona:active",
      proposedBy: { kind: "installer", id: "installer" },
    });
    expect(
      first.attestCandidate(
        rejected.candidateId,
        { kind: "candidate", candidateId: rejected.candidateId },
        "rejected",
      ),
    ).toMatchObject({ ok: true, value: { state: "rejected", residentId: null } });
    const activation = first.attestCandidate(
      active.candidateId,
      { kind: "candidate", candidateId: active.candidateId },
      "accepted",
    );
    expect(activation.ok).toBe(true);
    if (!activation.ok || activation.value.residentId === null) return;

    const restarted = new ResidentIdentityStore({ dataDir });
    expect(restarted.requireActiveResident(pending.candidateId)).toEqual({
      ok: false,
      reason: "candidate-pending",
    });
    expect(restarted.requireActiveResident(rejected.candidateId)).toEqual({
      ok: false,
      reason: "candidate-rejected",
    });
    expect(restarted.requireActiveResident(activation.value.residentId)).toMatchObject({
      ok: true,
      value: {
        candidateId: active.candidateId,
        residentId: activation.value.residentId,
        persona: "persona:active",
      },
    });
    expect(restarted.readResident(activation.value.residentId)).toMatchObject({
      active: true,
      scopeIds: [],
      grantIds: [],
    });
  });

  it("releases a requested residentId after rejection while pending and active candidates keep it reserved", () => {
    const dataDir = temporaryDirectory();
    const store = new ResidentIdentityStore({ dataDir });
    const rejected = store.createCandidate({
      persona: "persona:first",
      proposedBy: { kind: "installer", id: "installer" },
      residentId: "resident-retry",
    });
    expect(() =>
      store.createCandidate({
        persona: "persona:blocked-while-pending",
        proposedBy: { kind: "installer", id: "installer" },
        residentId: "resident-retry",
      }),
    ).toThrow(/already reserved/);
    expect(
      store.attestCandidate(
        rejected.candidateId,
        { kind: "candidate", candidateId: rejected.candidateId },
        "rejected",
      ),
    ).toMatchObject({ ok: true, value: { state: "rejected", residentId: null } });

    const restarted = new ResidentIdentityStore({ dataDir });
    const replacement = restarted.createCandidate({
      persona: "persona:replacement",
      proposedBy: { kind: "installer", id: "installer" },
      residentId: "resident-retry",
    });
    expect(
      restarted.attestCandidate(
        replacement.candidateId,
        { kind: "candidate", candidateId: replacement.candidateId },
        "accepted",
      ),
    ).toMatchObject({ ok: true, value: { residentId: "resident-retry" } });
    expect(() =>
      restarted.createCandidate({
        persona: "persona:blocked-while-active",
        proposedBy: { kind: "installer", id: "installer" },
        residentId: "resident-retry",
      }),
    ).toThrow(/already reserved/);
  });

  it("fails closed when the durable candidate-resident mapping is inconsistent", () => {
    const dataDir = temporaryDirectory();
    const store = new ResidentIdentityStore({ dataDir });
    const candidate = store.createCandidate({
      persona: "persona",
      proposedBy: { kind: "installer", id: "installer" },
    });
    const registryPath = join(dataDir, "registry.json");
    const record = JSON.parse(readFileSync(registryPath, "utf8")) as {
      candidates: Array<{ candidateId: string; state: string; residentId: string | null }>;
    };
    const stored = record.candidates.find((entry) => entry.candidateId === candidate.candidateId);
    if (stored === undefined) throw new Error("test candidate missing");
    stored.state = "active";
    stored.residentId = "resident-missing";
    writeFileSync(registryPath, JSON.stringify(record));

    expect(() => new ResidentIdentityStore({ dataDir })).toThrow(
      /active candidate .* has no resident record/,
    );
  });
});
