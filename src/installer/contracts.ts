import { randomUUID } from "node:crypto";

export const INSTALLER_DRAFT_SCHEMA_VERSION = 2;
export const INSTALL_CONFIG_SCHEMA_VERSION = 1;

export type InstallerStep = "credentials" | "bindings" | "frontend" | "memory" | "review";

export type CredentialMethod = "oauth" | "api-key";
export type CredentialStatus = "ready" | "incomplete";
export type CredentialType = "claude_oauth" | "codex_oauth" | "grok_oauth" | "api_key";
export type Lane = "primary" | "coding";

/** Public credential shape from plugin protocol v0. Secret material stays in the credential store. */
export interface CredentialRef {
  id: string;
  type: CredentialType;
  issuerId: string;
}

/** Installer-only metadata. This is never embedded in a lane binding or active config. */
export interface InstallerCredential {
  ref: CredentialRef;
  label: string;
  providerId: string;
  status: CredentialStatus;
}

export interface LaneBinding {
  residentId: string;
  lane: Lane;
  adapterId: string;
  credentialRef: CredentialRef;
  adapterConfig?: {
    baseUrl?: string;
    tokenCredentialRef?: CredentialRef;
  };
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

export type InstallerSideEffect = {
  kind: "memory_dir_created";
  path: string;
  ownerDraftId: string;
};

/**
 * Resumable installer state. It contains references only: secret material lives in the
 * draft credential store and never enters this JSON document.
 *
 * This is an installer-local contract. Its public CredentialRef and LaneBinding fields match
 * plugin protocol v0; the remaining draft-only fields do not claim to be plugin protocol.
 */
export interface InstallerDraft {
  schemaVersion: typeof INSTALLER_DRAFT_SCHEMA_VERSION;
  draftId: string;
  residentId: string;
  credentials: InstallerCredential[];
  bindings: LaneBinding[];
  frontend: FrontendChoice | null;
  memory: MemoryChoice | null;
  sideEffects: InstallerSideEffect[];
  progress: InstallerProgress;
}

export interface MistInstallConfigV0 {
  schemaVersion: typeof INSTALL_CONFIG_SCHEMA_VERSION;
  residentId: string;
  credentialRefs: CredentialRef[];
  bindings: LaneBinding[];
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

export function credentialSecretRef(credential: Pick<CredentialRef, "id">): string {
  assertSafeInstallerId(credential.id, "credential id");
  return `${credential.id}.credential`;
}

export function createInstallerDraft(residentId: string): InstallerDraft {
  if (residentId.trim().length === 0) {
    throw new InstallerValidationError("residentId must not be empty");
  }
  return {
    schemaVersion: INSTALLER_DRAFT_SCHEMA_VERSION,
    draftId: randomUUID(),
    residentId,
    credentials: [],
    bindings: [],
    frontend: null,
    memory: null,
    sideEffects: [],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InstallerValidationError(`${field} must be a string`);
  }
  requireNonEmpty(value, field);
  return value;
}

function validateFrontendChoice(value: unknown): FrontendChoice {
  if (!isRecord(value)) {
    throw new InstallerValidationError("frontend choice has an unsupported shape");
  }
  switch (value.kind) {
    case "external":
      if (value.integration !== "mist-session-api") {
        throw new InstallerValidationError(
          `external frontend has unsupported integration: ${String(value.integration)}`,
        );
      }
      return { kind: "external", integration: "mist-session-api" };
    case "official-skin":
      if (value.pluginId !== "mist-official-skin") {
        throw new InstallerValidationError(
          `official frontend has unsupported pluginId: ${String(value.pluginId)}`,
        );
      }
      if (value.installation !== "pending" && value.installation !== "installed") {
        throw new InstallerValidationError(
          `official frontend has unsupported installation: ${String(value.installation)}`,
        );
      }
      return {
        kind: "official-skin",
        pluginId: "mist-official-skin",
        installation: value.installation,
      };
    default:
      throw new InstallerValidationError(`unsupported frontend kind: ${String(value.kind)}`);
  }
}

function validateMemoryChoice(value: unknown): MemoryChoice {
  if (!isRecord(value)) {
    throw new InstallerValidationError("memory choice has an unsupported shape");
  }
  const path = requireString(value.path, "memory path");
  switch (value.kind) {
    case "existing":
      return { kind: "existing", path };
    case "create":
      return { kind: "create", path };
    default:
      throw new InstallerValidationError(`unsupported memory kind: ${String(value.kind)}`);
  }
}

function validateCredentialIssuer(credential: InstallerCredential): void {
  const expectedIssuer = credential.ref.type === "api_key" ? "mist-installer-api-key" : "pi";
  if (credential.ref.issuerId !== expectedIssuer) {
    throw new InstallerValidationError(
      `credential ${credential.ref.id} issuer is unavailable for type ${credential.ref.type}`,
    );
  }
}

const CREDENTIAL_TYPES = new Set<CredentialType>([
  "claude_oauth",
  "codex_oauth",
  "grok_oauth",
  "api_key",
]);
const CREDENTIAL_STATUSES = new Set<CredentialStatus>(["ready", "incomplete"]);
const LANES = new Set<Lane>(["primary", "coding"]);
const ADAPTER_CREDENTIAL_TYPES = {
  pi: new Set<CredentialType>(["codex_oauth", "grok_oauth", "api_key"]),
  "claude-agent-sdk": new Set<CredentialType>(["claude_oauth", "api_key"]),
} as const;

function validateCredentialEnums(credential: InstallerCredential): void {
  if (!CREDENTIAL_TYPES.has(credential.ref.type)) {
    throw new InstallerValidationError(
      `credential ${credential.ref.id} has unsupported type: ${String(credential.ref.type)}`,
    );
  }
  if (!CREDENTIAL_STATUSES.has(credential.status)) {
    throw new InstallerValidationError(
      `credential ${credential.ref.id} has unsupported status: ${String(credential.status)}`,
    );
  }
}

function validateBindingCredential(
  binding: LaneBinding,
  credentials: ReadonlyMap<string, InstallerCredential>,
): void {
  const credential = credentials.get(binding.credentialRef.id);
  if (credential === undefined) {
    throw new InstallerValidationError(
      `binding references unknown credential: ${binding.credentialRef.id}`,
    );
  }
  if (
    credential.ref.type !== binding.credentialRef.type ||
    credential.ref.issuerId !== binding.credentialRef.issuerId
  ) {
    throw new InstallerValidationError(
      `binding credential type or issuer does not match stored ref: ${binding.credentialRef.id}`,
    );
  }
  const acceptedTypes =
    ADAPTER_CREDENTIAL_TYPES[binding.adapterId as keyof typeof ADAPTER_CREDENTIAL_TYPES];
  if (acceptedTypes === undefined) {
    throw new InstallerValidationError(`unsupported binding adapter: ${binding.adapterId}`);
  }
  if (!acceptedTypes.has(credential.ref.type)) {
    throw new InstallerValidationError(
      `adapter ${binding.adapterId} does not accept credential type ${credential.ref.type}`,
    );
  }
}

export function validateReadyDraft(draft: InstallerDraft): MistInstallConfigV0 {
  if (draft.schemaVersion !== INSTALLER_DRAFT_SCHEMA_VERSION) {
    throw new InstallerValidationError(
      `unsupported installer draft schemaVersion: ${draft.schemaVersion}`,
    );
  }
  assertSafeInstallerId(draft.draftId, "draft id");
  requireNonEmpty(draft.residentId, "residentId");
  if (draft.credentials.length === 0) {
    throw new InstallerValidationError("at least one credential is required");
  }

  const credentials = new Map<string, InstallerCredential>();
  for (const credential of draft.credentials) {
    assertSafeInstallerId(credential.ref.id, "credential id");
    requireNonEmpty(credential.label, `credential ${credential.ref.id} label`);
    requireNonEmpty(credential.providerId, `credential ${credential.ref.id} providerId`);
    requireNonEmpty(credential.ref.issuerId, `credential ${credential.ref.id} issuerId`);
    validateCredentialEnums(credential);
    validateCredentialIssuer(credential);
    if (credential.status !== "ready") {
      throw new InstallerValidationError(`credential ${credential.ref.id} is incomplete`);
    }
    if (credentials.has(credential.ref.id)) {
      throw new InstallerValidationError(`duplicate credential id: ${credential.ref.id}`);
    }
    credentials.set(credential.ref.id, credential);
  }

  const bindings = new Set<string>();
  for (const binding of draft.bindings) {
    requireNonEmpty(binding.residentId, "binding residentId");
    if (binding.residentId !== draft.residentId) {
      throw new InstallerValidationError(
        `binding resident ${binding.residentId} does not match draft resident ${draft.residentId}`,
      );
    }
    if (!LANES.has(binding.lane)) {
      throw new InstallerValidationError(`unsupported binding lane: ${String(binding.lane)}`);
    }
    requireNonEmpty(binding.adapterId, "binding adapterId");
    const bindingKey = `${binding.residentId}\u0000${binding.lane}`;
    if (bindings.has(bindingKey)) {
      throw new InstallerValidationError(
        `duplicate ${binding.lane} binding for resident ${binding.residentId}`,
      );
    }
    bindings.add(bindingKey);
    validateBindingCredential(binding, credentials);
    const adapterConfig = binding.adapterConfig;
    if (adapterConfig !== undefined) {
      if (adapterConfig.baseUrl === undefined || adapterConfig.tokenCredentialRef === undefined) {
        throw new InstallerValidationError(
          `binding ${binding.lane} custom gateway requires baseUrl and tokenCredentialRef`,
        );
      }
      requireNonEmpty(adapterConfig.baseUrl, `binding ${binding.lane} baseUrl`);
      const tokenCredential = credentials.get(adapterConfig.tokenCredentialRef.id);
      if (
        tokenCredential === undefined ||
        tokenCredential.ref.type !== "api_key" ||
        adapterConfig.tokenCredentialRef.type !== "api_key" ||
        tokenCredential.ref.issuerId !== adapterConfig.tokenCredentialRef.issuerId
      ) {
        throw new InstallerValidationError(
          `binding ${binding.lane} tokenCredentialRef must reference an api_key`,
        );
      }
    }
  }
  if (!draft.bindings.some((binding) => binding.lane === "primary")) {
    throw new InstallerValidationError("a primary lane binding is required");
  }
  if (draft.frontend === null) {
    throw new InstallerValidationError("frontend choice is required");
  }
  const frontend = validateFrontendChoice(draft.frontend);
  if (frontend.kind === "official-skin" && frontend.installation !== "installed") {
    throw new InstallerValidationError(
      "official skin is pending issues #49 and #51 and cannot be activated yet",
    );
  }
  if (draft.memory === null) {
    throw new InstallerValidationError("memory choice is required");
  }
  const memory = validateMemoryChoice(draft.memory);

  return {
    schemaVersion: INSTALL_CONFIG_SCHEMA_VERSION,
    residentId: draft.residentId,
    credentialRefs: draft.credentials.map((credential) => ({ ...credential.ref })),
    bindings: draft.bindings.map((binding) => structuredClone(binding)),
    frontend,
    memory,
  };
}
