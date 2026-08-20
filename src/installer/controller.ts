import {
  type FrontendChoice,
  type InstallCommitReceipt,
  type InstallerCredential,
  type InstallerDraft,
  type InstallerStep,
  InstallerValidationError,
  type LaneBinding,
  type MemoryChoice,
  createInstallerDraft,
  credentialSecretRef,
} from "./contracts.ts";
import type { InstallerStateStore } from "./state-store.ts";

export type ExistingDraftChoice = "resume" | "discard";

function cloneDraft(draft: InstallerDraft): InstallerDraft {
  return structuredClone(draft);
}

function completeStep(draft: InstallerDraft, step: InstallerStep, next: InstallerStep): void {
  if (!draft.progress.completedSteps.includes(step)) {
    draft.progress.completedSteps.push(step);
  }
  draft.progress.currentStep = next;
  draft.progress.status = next === "review" ? "ready-to-commit" : "in-progress";
}

/** Resumable application service. Prompt rendering is deliberately outside this class. */
export class InstallerController {
  readonly #store: InstallerStateStore;
  #draft: InstallerDraft | null = null;
  #lastReceipt: InstallCommitReceipt | null = null;

  constructor(store: InstallerStateStore) {
    this.#store = store;
  }

  start(residentId: string, existingDraftChoice: ExistingDraftChoice = "resume"): InstallerDraft {
    const existing = this.#store.loadDraft();
    if (existing !== null && existingDraftChoice === "resume") {
      if (existing.residentId !== residentId) {
        throw new InstallerValidationError(
          `draft belongs to resident ${existing.residentId}, not ${residentId}`,
        );
      }
      this.#draft = existing;
      return cloneDraft(existing);
    }
    if (existing !== null) this.#store.discardDraft(existing.draftId);
    const draft = createInstallerDraft(residentId);
    this.#store.saveDraft(draft);
    this.#draft = draft;
    return cloneDraft(draft);
  }

  current(): InstallerDraft {
    return cloneDraft(this.#requireDraft());
  }

  /**
   * Rewinds to the credential step.
   *
   * `reset` clears the collected credentials as well, for the case where the saved
   * set is itself what got rejected: the runner re-collects from `draft.credentials`,
   * so keeping a rejected set would replay the same rejection. The default keeps
   * them, which is what the "no compatible credential for this adapter" path wants.
   */
  revisitCredentials(options: { reset?: boolean } = {}): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    draft.progress.currentStep = "credentials";
    draft.progress.status = "in-progress";
    draft.progress.completedSteps = draft.progress.completedSteps.filter(
      (step) => step !== "credentials" && step !== "bindings",
    );
    draft.bindings = [];
    if (options.reset === true) draft.credentials = [];
    this.#persist(draft);
    return cloneDraft(draft);
  }

  /**
   * Rewinds to the binding step, keeping the collected credentials.
   *
   * For a commit rejected because of a binding (wrong resident, missing primary lane,
   * bad gateway config) the credentials are fine; sending the user back to step 1
   * would throw away work that was never the problem.
   */
  revisitBindings(): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    draft.progress.currentStep = "bindings";
    draft.progress.status = "in-progress";
    draft.progress.completedSteps = draft.progress.completedSteps.filter(
      (step) => step !== "bindings",
    );
    draft.bindings = [];
    this.#persist(draft);
    return cloneDraft(draft);
  }

  /**
   * Sends a stuck review back to the memory step so another path can be chosen.
   *
   * `revisitFrontend` cannot stand in for this: it only rewinds to frontend, and
   * once frontend is saved again the still-populated memory step is skipped and the
   * draft lands back on review — where the unusable path fails again.
   */
  revisitMemory(): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    draft.progress.currentStep = "memory";
    draft.progress.status = "in-progress";
    draft.progress.completedSteps = draft.progress.completedSteps.filter(
      (step) => step !== "memory",
    );
    draft.memory = null;
    this.#persist(draft);
    return cloneDraft(draft);
  }

  revisitFrontend(): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    draft.progress.currentStep = "frontend";
    draft.progress.status = "in-progress";
    draft.progress.completedSteps = draft.progress.completedSteps.filter(
      (step) => step !== "frontend",
    );
    draft.frontend = null;
    this.#persist(draft);
    return cloneDraft(draft);
  }

  saveCredentials(
    entries: readonly { credential: InstallerCredential; secret?: string }[],
  ): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    if (entries.length === 0) {
      throw new InstallerValidationError("at least one credential is required");
    }
    // Reject duplicate ids here, with the same rule and wording commit uses.
    // Leaving it to commit strands the draft at review: commit throws, and review
    // has no way back to step 1, so the only exit is discarding everything.
    // Checked before staging so a rejected batch leaves no orphan secret.
    const seenIds = new Set<string>();
    for (const entry of entries) {
      const id = entry.credential.ref.id;
      if (seenIds.has(id)) {
        throw new InstallerValidationError(`duplicate credential id: ${id}`);
      }
      seenIds.add(id);
    }
    const credentials: InstallerCredential[] = [];
    for (const entry of entries) {
      const secretRef = credentialSecretRef(entry.credential.ref);
      if (entry.secret !== undefined) {
        this.#store.stageSecret(draft.draftId, secretRef, entry.secret);
      }
      const status = this.#store.hasStagedSecret(draft.draftId, secretRef) ? "ready" : "incomplete";
      credentials.push({ ...entry.credential, ref: { ...entry.credential.ref }, status });
    }
    draft.credentials = credentials;
    completeStep(draft, "credentials", "bindings");
    this.#persist(draft);
    return cloneDraft(draft);
  }

  saveBindings(bindings: readonly LaneBinding[]): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    if (!bindings.some((binding) => binding.lane === "primary")) {
      throw new InstallerValidationError("a primary lane binding is required");
    }
    draft.bindings = bindings.map((binding) => structuredClone(binding));
    // After a rewind to bindings the later steps may still be filled in; skip them the
    // same way saveFrontend already skips a filled-in memory step.
    completeStep(
      draft,
      "bindings",
      draft.frontend === null ? "frontend" : draft.memory === null ? "memory" : "review",
    );
    this.#persist(draft);
    return cloneDraft(draft);
  }

  saveFrontend(frontend: FrontendChoice): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    draft.frontend = { ...frontend };
    completeStep(draft, "frontend", draft.memory === null ? "memory" : "review");
    this.#persist(draft);
    return cloneDraft(draft);
  }

  saveMemory(memory: MemoryChoice): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    if (memory.path.trim().length === 0) {
      throw new InstallerValidationError("memory path must not be empty");
    }
    draft.memory = { ...memory };
    draft.sideEffects =
      memory.kind === "create"
        ? [{ kind: "memory_dir_created", path: memory.path, ownerDraftId: draft.draftId }]
        : [];
    completeStep(draft, "memory", "review");
    this.#persist(draft);
    return cloneDraft(draft);
  }

  commit(): InstallCommitReceipt {
    if (this.#draft === null && this.#lastReceipt !== null) {
      return structuredClone(this.#lastReceipt);
    }
    const receipt = this.#store.commit(this.#requireDraft());
    this.#draft = null;
    this.#lastReceipt = receipt;
    return structuredClone(receipt);
  }

  discard(): void {
    this.#store.discardDraft(this.#requireDraft().draftId);
    this.#draft = null;
  }

  #requireDraft(): InstallerDraft {
    if (this.#draft === null) {
      throw new InstallerValidationError("installer has not been started");
    }
    return this.#draft;
  }

  #persist(draft: InstallerDraft): void {
    this.#store.saveDraft(draft);
    this.#draft = draft;
  }
}
