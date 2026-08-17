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

  revisitCredentials(): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    draft.progress.currentStep = "credentials";
    draft.progress.status = "in-progress";
    draft.progress.completedSteps = draft.progress.completedSteps.filter(
      (step) => step !== "credentials" && step !== "bindings",
    );
    draft.bindings = [];
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
    completeStep(draft, "bindings", "frontend");
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
