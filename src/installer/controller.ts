import {
  type ChannelBinding,
  type CredentialRef,
  type FrontendChoice,
  type InstallCommitReceipt,
  type InstallerDraft,
  type InstallerStep,
  InstallerValidationError,
  type MemoryChoice,
  createInstallerDraft,
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
    if (existing !== null) this.#store.discardDraft();
    const draft = createInstallerDraft(residentId);
    this.#store.saveDraft(draft);
    this.#draft = draft;
    return cloneDraft(draft);
  }

  current(): InstallerDraft {
    return cloneDraft(this.#requireDraft());
  }

  saveCredentials(entries: readonly { ref: CredentialRef; secret?: string }[]): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    if (entries.length === 0) {
      throw new InstallerValidationError("at least one credential is required");
    }
    const refs: CredentialRef[] = [];
    for (const entry of entries) {
      if (entry.secret !== undefined) {
        this.#store.stageSecret(entry.ref.secretRef, entry.secret);
      }
      const status = this.#store.hasStagedSecret(entry.ref.secretRef) ? "ready" : "incomplete";
      refs.push({ ...entry.ref, status });
    }
    draft.credentialRefs = refs;
    completeStep(draft, "credentials", "bindings");
    this.#persist(draft);
    return cloneDraft(draft);
  }

  saveBindings(bindings: readonly ChannelBinding[]): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    if (!bindings.some((binding) => binding.purpose === "main")) {
      throw new InstallerValidationError("a main channel binding is required");
    }
    draft.bindings = bindings.map((binding) => ({ ...binding }));
    completeStep(draft, "bindings", "frontend");
    this.#persist(draft);
    return cloneDraft(draft);
  }

  saveFrontend(frontend: FrontendChoice): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    draft.frontend = { ...frontend };
    completeStep(draft, "frontend", "memory");
    this.#persist(draft);
    return cloneDraft(draft);
  }

  saveMemory(memory: MemoryChoice): InstallerDraft {
    const draft = cloneDraft(this.#requireDraft());
    if (memory.path.trim().length === 0) {
      throw new InstallerValidationError("memory path must not be empty");
    }
    draft.memory = { ...memory };
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
    this.#store.discardDraft();
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
