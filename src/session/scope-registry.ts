import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ScopeActivation {
  readonly residentId: string;
  readonly scopeId: string;
  readonly scopeGeneration: number;
  readonly status: "active" | "inactive";
}

export class ScopeInactiveError extends Error {
  readonly code = "SCOPE_INACTIVE";
  constructor(residentId: string, scopeId: string) {
    super(`SCOPE_INACTIVE: ${residentId}/${scopeId}`);
    this.name = "ScopeInactiveError";
  }
}

/** Host-owned, single-writer activation authority; retirement is not full scope closure. */
export class ScopeRegistry {
  readonly #states = new Map<string, ScopeActivation>();
  readonly #journalPath: string | undefined;
  #failed = false;
  #hasJournal = false;

  constructor(options: { journalPath?: string } = {}) {
    this.#journalPath = options.journalPath;
    if (this.#journalPath === undefined) return;
    mkdirSync(dirname(this.#journalPath), { recursive: true });
    if (!existsSync(this.#journalPath)) return;
    this.#hasJournal = true;
    const contents = readFileSync(this.#journalPath, "utf8");
    if (contents.length > 0 && !contents.endsWith("\n")) {
      throw new Error("incomplete scope journal");
    }
    for (const line of contents.split("\n")) {
      if (line === "") continue;
      const raw: unknown = JSON.parse(line);
      if (typeof raw !== "object" || raw === null) throw new Error("invalid scope record");
      const record = raw as { schemaVersion?: unknown; activation?: Partial<ScopeActivation> };
      const state = record.activation;
      if (
        record.schemaVersion !== 1 ||
        state === undefined ||
        state === null ||
        typeof state.residentId !== "string" ||
        typeof state.scopeId !== "string" ||
        typeof state.scopeGeneration !== "number" ||
        (state.status !== "active" && state.status !== "inactive")
      )
        throw new Error("invalid scope record");
      const activation: ScopeActivation = {
        residentId: state.residentId,
        scopeId: state.scopeId,
        scopeGeneration: state.scopeGeneration,
        status: state.status,
      };
      this.#validateTransition(activation);
      this.#states.set(this.#key(activation.residentId, activation.scopeId), activation);
    }
  }

  #key(residentId: string, scopeId: string): string {
    if (
      typeof residentId !== "string" ||
      residentId.length === 0 ||
      typeof scopeId !== "string" ||
      scopeId.length === 0
    ) {
      throw new Error("scope requires residentId and scopeId");
    }
    return JSON.stringify([residentId, scopeId]);
  }

  #healthy(): void {
    if (this.#failed) throw new Error("scope journal failed; host recovery required");
  }

  #validateTransition(next: ScopeActivation): void {
    const previous = this.#states.get(this.#key(next.residentId, next.scopeId));
    if (!Number.isSafeInteger(next.scopeGeneration) || next.scopeGeneration < 1) {
      throw new Error("invalid scope generation");
    }
    const valid =
      previous === undefined
        ? next.status === "active" && next.scopeGeneration === 1
        : previous.status === "active"
          ? next.status === "inactive" && next.scopeGeneration === previous.scopeGeneration
          : next.status === "active" && next.scopeGeneration === previous.scopeGeneration + 1;
    if (!valid) throw new Error("invalid scope activation transition");
  }

  #commit(next: ScopeActivation): ScopeActivation {
    this.#healthy();
    this.#validateTransition(next);
    if (this.#journalPath !== undefined) {
      try {
        if (this.#hasJournal && !existsSync(this.#journalPath)) {
          throw new Error("scope journal disappeared");
        }
        appendFileSync(
          this.#journalPath,
          `${JSON.stringify({ schemaVersion: 1, activation: next })}\n`,
          { encoding: "utf8", flush: true },
        );
        this.#hasJournal = true;
      } catch (error) {
        this.#failed = true;
        throw error;
      }
    }
    this.#states.set(this.#key(next.residentId, next.scopeId), next);
    return { ...next };
  }

  get(residentId: string, scopeId: string): ScopeActivation | undefined {
    this.#healthy();
    const state = this.#states.get(this.#key(residentId, scopeId));
    return state === undefined ? undefined : { ...state };
  }

  activeScopesOf(residentId: string): ScopeActivation[] {
    this.#healthy();
    return [...this.#states.values()]
      .filter((state) => state.residentId === residentId && state.status === "active")
      .map((state) => ({ ...state }));
  }

  activate(residentId: string, scopeId: string): ScopeActivation {
    const previous = this.get(residentId, scopeId);
    if (previous?.status === "active") return previous;
    return this.#commit({
      residentId,
      scopeId,
      scopeGeneration: (previous?.scopeGeneration ?? 0) + 1,
      status: "active",
    });
  }

  retire(residentId: string, scopeId: string, scopeGeneration: number): ScopeActivation {
    const previous = this.get(residentId, scopeId);
    if (!Number.isSafeInteger(scopeGeneration) || previous?.scopeGeneration !== scopeGeneration) {
      throw new Error("scope activation mismatch");
    }
    if (previous.status === "inactive") return previous;
    return this.#commit({ ...previous, status: "inactive" });
  }
}
