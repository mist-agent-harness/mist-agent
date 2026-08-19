import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CredentialMethod,
  FrontendChoice,
  InstallCommitReceipt,
  InstallerCredential,
  InstallerDraft,
  LaneBinding,
  MemoryChoice,
} from "./contracts.ts";
import { InstallerValidationError, installerAdapterAcceptsCredentialType } from "./contracts.ts";
import type { InstallerController } from "./controller.ts";
import type { MemoryLibraryPort } from "./memory-library.ts";
import type { OAuthLoginPort } from "./pi-login.ts";
import type { PromptPort } from "./prompt-port.ts";
import { PROVIDERS, credentialIssuerIdFor, credentialTypeFor, providerById } from "./providers.ts";
import type { InstallerStateStore } from "./state-store.ts";

export interface RunInstallerOptions {
  residentId: string;
  dataDir: string;
  controller: InstallerController;
  store: InstallerStateStore;
  prompt: PromptPort;
  oauth: OAuthLoginPort;
  memoryLibraries: MemoryLibraryPort;
}

export type RunInstallerResult =
  | { status: "committed"; receipt: InstallCommitReceipt }
  | { status: "paused"; draft: InstallerDraft }
  | { status: "dependency-pending"; draft: InstallerDraft; dependencies: ["#49", "#51"] }
  | { status: "already-configured" };

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length === 0 ? "credential" : normalized;
}

class MissingCompatibleCredentialError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string) {
    super(`no credential can be used with adapter ${adapterId}`);
    this.name = "MissingCompatibleCredentialError";
    this.adapterId = adapterId;
  }
}

async function collectCredentials(
  options: RunInstallerOptions,
  draft: InstallerDraft,
): Promise<void> {
  const entries: { credential: InstallerCredential; secret?: string }[] = draft.credentials.map(
    (credential) => ({ credential }),
  );
  do {
    const providerId = await options.prompt.select({
      message: "Step 1/4 · Credential provider",
      choices: PROVIDERS.map((provider) => ({
        value: provider.id,
        name: provider.label,
        description: provider.methods.includes("oauth")
          ? "Pi OAuth or API key"
          : "API key (Pi does not currently expose OAuth for this provider)",
      })),
      default: "codex",
    });
    const provider = providerById(providerId);
    const method = await options.prompt.select<CredentialMethod>({
      message: `How should ${provider.label} authenticate?`,
      choices: provider.methods.map((candidate) => ({
        value: candidate,
        name: candidate === "oauth" ? "Sign in through Pi" : "Enter an API key",
      })),
      default: provider.methods[0],
    });
    const suggestedId = `${provider.id}-${method === "oauth" ? "login" : "key"}`;
    const name = await options.prompt.input({
      message: "Credential name",
      default: suggestedId,
    });
    const id = slug(name);
    let secret: string;
    if (method === "oauth") {
      secret = (await options.oauth.login(provider)).locator;
    } else {
      secret = await options.prompt.secret({ message: `${provider.label} API key` });
    }
    entries.push({
      credential: {
        ref: {
          id,
          type: credentialTypeFor(provider, method),
          issuerId: credentialIssuerIdFor(method),
        },
        label: name,
        providerId: provider.id,
        status: "incomplete",
      },
      secret,
    });
    if (provider.id === "claude" && method === "oauth") {
      options.prompt.info(
        `Saved as ${id}. A Claude subscription login can only run through the Claude Agent SDK adapter.`,
      );
    }
  } while (await options.prompt.confirm({ message: "Add another credential?", default: false }));
  options.controller.saveCredentials(entries);
}

function compatibleCredentials(
  draft: InstallerDraft,
  adapterId: "pi" | "claude-agent-sdk",
): InstallerCredential[] {
  return draft.credentials.filter((credential) =>
    installerAdapterAcceptsCredentialType(adapterId, credential.ref.type),
  );
}

async function chooseCredential(
  options: RunInstallerOptions,
  draft: InstallerDraft,
  adapterId: "pi" | "claude-agent-sdk",
): Promise<InstallerCredential> {
  const compatible = compatibleCredentials(draft, adapterId);
  if (compatible.length === 0) {
    throw new MissingCompatibleCredentialError(adapterId);
  }
  const defaultCredential = compatible[0];
  if (defaultCredential === undefined) {
    throw new Error(`no credential can be used with adapter ${adapterId}`);
  }
  const credentialId = await options.prompt.select({
    message: "Step 2/4 · Primary/coding lane credential",
    choices: compatible.map((credential) => ({
      value: credential.ref.id,
      name: credential.label,
      description: `${credential.ref.id} · ${credential.ref.type}`,
    })),
    default: defaultCredential.ref.id,
  });
  const selected = compatible.find((credential) => credential.ref.id === credentialId);
  if (selected === undefined) throw new Error(`unknown credential selection: ${credentialId}`);
  return selected;
}

async function collectBindings(options: RunInstallerOptions, draft: InstallerDraft): Promise<void> {
  const primaryCredential = await chooseCredential(options, draft, "pi");
  const bindings: LaneBinding[] = [
    {
      residentId: draft.residentId,
      lane: "primary",
      adapterId: "pi",
      credentialRef: { ...primaryCredential.ref },
    },
  ];
  if (
    await options.prompt.confirm({ message: "Configure a separate coding channel?", default: true })
  ) {
    const codingCredential = await chooseCredential(options, draft, "claude-agent-sdk");
    const codingBinding: LaneBinding = {
      residentId: draft.residentId,
      lane: "coding",
      adapterId: "claude-agent-sdk",
      credentialRef: { ...codingCredential.ref },
    };
    if (
      await options.prompt.confirm({
        message: "Use a custom Claude-compatible gateway?",
        default: false,
      })
    ) {
      const apiKeys = draft.credentials.filter((credential) => credential.ref.type === "api_key");
      const defaultToken = apiKeys[0];
      if (defaultToken === undefined) {
        throw new Error("a custom gateway requires an API key credential");
      }
      const baseUrl = await options.prompt.input({ message: "Gateway base URL" });
      const tokenCredentialId = await options.prompt.select({
        message: "Gateway token credential",
        choices: apiKeys.map((credential) => ({
          value: credential.ref.id,
          name: credential.label,
          description: credential.ref.id,
        })),
        default: defaultToken.ref.id,
      });
      const tokenCredential = apiKeys.find((credential) => credential.ref.id === tokenCredentialId);
      if (tokenCredential === undefined) {
        throw new Error(`unknown gateway token credential: ${tokenCredentialId}`);
      }
      codingBinding.adapterConfig = {
        baseUrl,
        tokenCredentialRef: { ...tokenCredential.ref },
      };
    }
    bindings.push(codingBinding);
  }
  options.controller.saveBindings(bindings);
}

async function collectFrontend(options: RunInstallerOptions): Promise<void> {
  const kind = await options.prompt.select<FrontendChoice["kind"]>({
    message: "Step 3/4 · Frontend",
    choices: [
      { value: "official-skin", name: "Install the official Mist skin" },
      { value: "external", name: "Connect my own frontend" },
    ],
    default: "official-skin",
  });
  if (kind === "official-skin") {
    options.prompt.info(
      "The official skin install seam is reserved. It will activate when issues #49 and #51 land.",
    );
    options.controller.saveFrontend({
      kind,
      pluginId: "mist-official-skin",
      installation: "pending",
    });
    return;
  }
  options.prompt.info("Use the Mist session API contract to connect your existing frontend.");
  options.controller.saveFrontend({ kind, integration: "mist-session-api" });
}

async function collectMemory(options: RunInstallerOptions): Promise<void> {
  const kind = await options.prompt.select<MemoryChoice["kind"]>({
    message: "Step 4/4 · Memory library",
    choices: [
      { value: "existing", name: "Use an existing memory library" },
      { value: "create", name: "Create an empty memory library" },
    ],
    default: "create",
  });
  const inputPath = await options.prompt.input({
    message: kind === "existing" ? "Existing memory path" : "New memory path",
    default: join(options.dataDir, "memory"),
  });
  const path =
    inputPath === "~" || inputPath.startsWith("~/")
      ? join(homedir(), inputPath.slice(2))
      : inputPath;
  if (kind === "existing") {
    options.memoryLibraries.assertExisting(path);
    options.controller.saveMemory({ kind, path });
    return;
  }
  // Record the intended side effect before creating it. If the process dies between these
  // operations, resume can safely recreate it; discard still knows exactly what may be removed.
  const draft = options.controller.saveMemory({ kind, path });
  options.memoryLibraries.createEmpty(path, draft.draftId);
}

export async function runInstaller(options: RunInstallerOptions): Promise<RunInstallerResult> {
  const existing = options.store.loadDraft();
  const current = options.store.loadCurrentConfig();
  if (existing === null && current === null) {
    options.prompt.info(
      "Welcome to Mist setup. Four steps: credentials → channels → frontend → memory. You can quit any time; only a draft is kept until you confirm.",
    );
  }
  if (existing === null && current !== null) {
    const choice = await options.prompt.select({
      message: "Mist is already configured",
      choices: [
        { value: "keep", name: "Keep the current setup" },
        { value: "reconfigure", name: "Start a replacement draft" },
      ],
      default: "keep",
    });
    if (choice === "keep") return { status: "already-configured" };
  }
  const choice =
    existing === null
      ? "resume"
      : await options.prompt.select({
          message: "An unfinished setup was found",
          choices: [
            { value: "resume", name: "Continue where I stopped" },
            { value: "discard", name: "Discard it and start over" },
          ],
          default: "resume",
        });
  if (existing !== null && choice === "discard") {
    for (const sideEffect of existing.sideEffects) {
      if (sideEffect.kind === "memory_dir_created") {
        options.memoryLibraries.discardEmpty(sideEffect.path, sideEffect.ownerDraftId);
      }
    }
  }
  let draft = options.controller.start(options.residentId, choice);

  while (true) {
    switch (draft.progress.currentStep) {
      case "credentials":
        await collectCredentials(options, draft);
        break;
      case "bindings":
        try {
          await collectBindings(options, draft);
        } catch (error) {
          if (!(error instanceof MissingCompatibleCredentialError)) throw error;
          options.prompt.info(
            `No saved credential can be used with ${error.adapterId}. Add one now — your draft is kept.`,
          );
          options.controller.revisitCredentials();
        }
        break;
      case "frontend":
        await collectFrontend(options);
        break;
      case "memory":
        await collectMemory(options);
        break;
      case "review": {
        if (draft.memory?.kind === "create") {
          // Idempotently finish a creation interrupted after the draft was persisted.
          try {
            options.memoryLibraries.createEmpty(draft.memory.path, draft.draftId);
          } catch (error) {
            // The path is taken by a directory mist did not create, so createEmpty
            // refuses. Letting this escape strands the draft for good: every later
            // resume lands on review again and re-runs this same call.
            options.prompt.info(
              `The memory library at ${draft.memory.path} cannot be created: ${
                error instanceof Error ? error.message : String(error)
              }. Your draft is kept — choose another path.`,
            );
            options.controller.revisitMemory();
            break;
          }
        }
        options.prompt.info(formatReview(draft));
        if (draft.frontend?.kind === "official-skin") {
          options.prompt.info(
            "The official skin is not installed: issues #49 and #51 are still pending. This draft was kept and no active config changed.",
          );
          const pendingChoice = await options.prompt.select({
            message: "Official skin dependencies are still pending",
            choices: [
              { value: "keep", name: "Keep this draft and exit" },
              { value: "change", name: "Choose a different frontend" },
            ],
            default: "keep",
          });
          if (pendingChoice === "keep") {
            return { status: "dependency-pending", draft, dependencies: ["#49", "#51"] };
          }
          options.controller.revisitFrontend();
          break;
        }
        const shouldCommit = await options.prompt.confirm({
          message: "Save this setup?",
          default: true,
        });
        if (!shouldCommit) return { status: "paused", draft };
        try {
          return { status: "committed", receipt: options.controller.commit() };
        } catch (error) {
          // Validation that only commit can see (duplicate ids being the known case)
          // must not be a dead end: review had no way back to step 1, so the only
          // exit was discarding the whole draft.
          if (!(error instanceof InstallerValidationError)) throw error;
          options.prompt.info(
            `This setup cannot be saved: ${error.message}. Your draft is kept and no active config changed.`,
          );
          const fixChoice = await options.prompt.select({
            message: "How do you want to continue?",
            choices: [
              { value: "credentials", name: "Go back to credentials and fix it" },
              { value: "keep", name: "Keep this draft and exit" },
            ],
            default: "credentials",
          });
          if (fixChoice === "keep")
            return { status: "paused", draft: options.controller.current() };
          options.controller.revisitCredentials({ reset: true });
          break;
        }
      }
    }
    draft = options.controller.current();
  }
}

function formatReview(draft: InstallerDraft): string {
  const credentials = draft.credentials
    .map(
      (credential) =>
        `${credential.ref.id} (${credential.providerId}, ${credential.ref.type}, ${credential.ref.issuerId}, ${credential.status})`,
    )
    .join(", ");
  const bindings = draft.bindings
    .map(
      (binding) =>
        `${binding.lane}: ${binding.adapterId} · ${binding.credentialRef.id}${
          binding.adapterConfig?.baseUrl === undefined
            ? ""
            : ` · gateway ${binding.adapterConfig.baseUrl}`
        }`,
    )
    .join("\n  ");
  const frontend =
    draft.frontend?.kind === "external"
      ? "external · mist-session-api"
      : "official-skin · pending #49/#51";
  const memory =
    draft.memory === null ? "not configured" : `${draft.memory.kind} · ${draft.memory.path}`;
  return `Review your setup (active config is unchanged):\n  Credentials: ${credentials}\n  ${bindings}\n  Frontend: ${frontend}\n  Memory: ${memory}`;
}
