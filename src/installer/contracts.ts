export const INSTALLER_DRAFT_SCHEMA_VERSION = 1;
export const INSTALL_CONFIG_SCHEMA_VERSION = 1;

export type InstallerStep = "credentials" | "bindings" | "frontend" | "memory" | "review";

export type CredentialMethod = "oauth" | "api-key";
export type CredentialStatus = "ready" | "incomplete";
export type BindingPurpose = "main" | "coding";

export interface CredentialRef {
  id: string;
  label: string;
  providerId: string;
  method: CredentialMethod;
  secretRef: string;
  status: CredentialStatus;
  /** Claude OAuth may only execute through the Claude Agent SDK adapter. */
  adapterConstraint?: "claude-agent-sdk";
}

export interface ChannelBinding {
  residentId: string;
  purpose: BindingPurpose;
  adapterId: string;
  credentialId: string;
}

export type FrontendChoice =
  | {
      kind: "external";
      integration: "mist-session-api";
    }
  | {
      kind: "official-skin";
      pluginId: "mist-official-skin";
      /** Issue #50 deliberately leaves this branch pending until issues #49 and #51 land. */
      installation: "pending" | "installed";
    };

export type MemoryChoice =
  | {
      kind: "existing";
      path: string;
    }
  | {
      kind: "create";
      path: string;
    };

export interface InstallerProgress {
  currentStep: InstallerStep;
  completedSteps: InstallerStep[];
  status: "in-progress" | "ready-to-commit";
}

/**
 * Resumable installer state. It contains references only: secret material lives in the
 * draft credential store and never enters this JSON document.
 *
 * This is an installer-local contract, not the final plugin RFC from issue #51. The commit
 * boundary is the only place that will need to translate when that RFC freezes.
 */
export interface InstallerDraft {
  schemaVersion: typeof INSTALLER_DRAFT_SCHEMA_VERSION;
  residentId: string;
  credentialRefs: CredentialRef[];
  bindings: ChannelBinding[];
  frontend: FrontendChoice | null;
  memory: MemoryChoice | null;
  progress: InstallerProgress;
}

export interface MistInstallConfigV0 {
  schemaVersion: typeof INSTALL_CONFIG_SCHEMA_VERSION;
  residentId: string;
  credentialRefs: CredentialRef[];
  bindings: ChannelBinding[];
  frontend: FrontendChoice;
  memory: MemoryChoice;
}

export interface InstallCommitReceipt {
  snapshotId: string;
  config: MistInstallConfigV0;
}

export class InstallerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallerValidationError";
  }
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function assertSafeInstallerId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) {
    throw new InstallerValidationError(
      `${field} must start with a lowercase letter or digit and contain only a-z, 0-9, ., _, or -`,
    );
  }
}

export function createInstallerDraft(residentId: string): InstallerDraft {
  if (residentId.trim().length === 0) {
    throw new InstallerValidationError("residentId must not be empty");
  }
  return {
    schemaVersion: INSTALLER_DRAFT_SCHEMA_VERSION,
    residentId,
    credentialRefs: [],
    bindings: [],
    frontend: null,
    memory: null,
    progress: {
      currentStep: "credentials",
      completedSteps: [],
      status: "in-progress",
    },
  };
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new InstallerValidationError(`${field} must not be empty`);
  }
}

export function validateReadyDraft(draft: InstallerDraft): MistInstallConfigV0 {
  if (draft.schemaVersion !== INSTALLER_DRAFT_SCHEMA_VERSION) {
    throw new InstallerValidationError(
      `unsupported installer draft schemaVersion: ${draft.schemaVersion}`,
    );
  }
  requireNonEmpty(draft.residentId, "residentId");
  if (draft.credentialRefs.length === 0) {
    throw new InstallerValidationError("at least one credential is required");
  }

  const credentials = new Map<string, CredentialRef>();
  const secretRefs = new Set<string>();
  for (const credential of draft.credentialRefs) {
    assertSafeInstallerId(credential.id, "credential id");
    assertSafeInstallerId(credential.secretRef, "credential secretRef");
    requireNonEmpty(credential.label, `credential ${credential.id} label`);
    requireNonEmpty(credential.providerId, `credential ${credential.id} providerId`);
    if (credential.status !== "ready") {
      throw new InstallerValidationError(`credential ${credential.id} is incomplete`);
    }
    if (credentials.has(credential.id)) {
      throw new InstallerValidationError(`duplicate credential id: ${credential.id}`);
    }
    if (secretRefs.has(credential.secretRef)) {
      throw new InstallerValidationError(`duplicate credential secretRef: ${credential.secretRef}`);
    }
    credentials.set(credential.id, credential);
    secretRefs.add(credential.secretRef);
  }

  const bindings = new Set<string>();
  for (const binding of draft.bindings) {
    requireNonEmpty(binding.residentId, "binding residentId");
    requireNonEmpty(binding.adapterId, "binding adapterId");
    const bindingKey = `${binding.residentId}\u0000${binding.purpose}`;
    if (bindings.has(bindingKey)) {
      throw new InstallerValidationError(
        `duplicate ${binding.purpose} binding for resident ${binding.residentId}`,
      );
    }
    bindings.add(bindingKey);
    const credential = credentials.get(binding.credentialId);
    if (credential === undefined) {
      throw new InstallerValidationError(
        `binding references unknown credential: ${binding.credentialId}`,
      );
    }
    if (
      credential.adapterConstraint !== undefined &&
      credential.adapterConstraint !== binding.adapterId
    ) {
      throw new InstallerValidationError(
        `credential ${credential.id} requires adapter ${credential.adapterConstraint}`,
      );
    }
  }
  if (!draft.bindings.some((binding) => binding.purpose === "main")) {
    throw new InstallerValidationError("a main channel binding is required");
  }
  if (draft.frontend === null) {
    throw new InstallerValidationError("frontend choice is required");
  }
  if (draft.frontend.kind === "official-skin" && draft.frontend.installation !== "installed") {
    throw new InstallerValidationError(
      "official skin is pending issues #49 and #51 and cannot be activated yet",
    );
  }
  if (draft.memory === null) {
    throw new InstallerValidationError("memory choice is required");
  }
  requireNonEmpty(draft.memory.path, "memory path");

  return {
    schemaVersion: INSTALL_CONFIG_SCHEMA_VERSION,
    residentId: draft.residentId,
    credentialRefs: draft.credentialRefs.map((credential) => ({ ...credential })),
    bindings: draft.bindings.map((binding) => ({ ...binding })),
    frontend: { ...draft.frontend },
    memory: { ...draft.memory },
  };
}
