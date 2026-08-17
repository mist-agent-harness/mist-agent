import { join } from "node:path";
import type {
  ChannelBinding,
  CredentialMethod,
  CredentialRef,
  FrontendChoice,
  InstallCommitReceipt,
  InstallerDraft,
  MemoryChoice,
} from "./contracts.ts";
import type { InstallerController } from "./controller.ts";
import type { MemoryLibraryPort } from "./memory-library.ts";
import type { OAuthLoginPort } from "./pi-login.ts";
import type { PromptPort } from "./prompt-port.ts";
import { PROVIDERS, providerById } from "./providers.ts";
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

async function collectCredentials(options: RunInstallerOptions): Promise<void> {
  const entries: { ref: CredentialRef; secret: string }[] = [];
  do {
    const providerId = await options.prompt.select({
      message: "Choose a credential provider",
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
    const id = slug(
      await options.prompt.input({ message: "Credential name", default: suggestedId }),
    );
    const secretRef = `${id}.credential`;
    let secret: string;
    if (method === "oauth") {
      secret = (await options.oauth.login(provider)).locator;
    } else {
      secret = await options.prompt.secret({ message: `${provider.label} API key` });
    }
    entries.push({
      ref: {
        id,
        label: provider.label,
        providerId: provider.id,
        method,
        secretRef,
        status: "incomplete",
        ...(method === "oauth" && provider.oauthAdapterConstraint !== undefined
          ? { adapterConstraint: provider.oauthAdapterConstraint }
          : {}),
      },
      secret,
    });
  } while (await options.prompt.confirm({ message: "Add another credential?", default: false }));
  options.controller.saveCredentials(entries);
}

async function chooseBinding(
  options: RunInstallerOptions,
  draft: InstallerDraft,
  purpose: "main" | "coding",
): Promise<ChannelBinding> {
  const adapterId = await options.prompt.select({
    message: purpose === "main" ? "Daily channel adapter" : "Coding channel adapter",
    choices: [
      { value: "pi", name: "Pi" },
      { value: "claude-agent-sdk", name: "Claude Agent SDK" },
    ],
    default: purpose === "main" ? "pi" : "claude-agent-sdk",
  });
  const compatible = draft.credentialRefs.filter(
    (credential) =>
      credential.adapterConstraint === undefined || credential.adapterConstraint === adapterId,
  );
  if (compatible.length === 0) {
    throw new Error(`no credential can be used with adapter ${adapterId}`);
  }
  const defaultCredential = compatible[0];
  if (defaultCredential === undefined) {
    throw new Error(`no credential can be used with adapter ${adapterId}`);
  }
  const credentialId = await options.prompt.select({
    message: "Credential",
    choices: compatible.map((credential) => ({
      value: credential.id,
      name: credential.label,
      description: credential.id,
    })),
    default: defaultCredential.id,
  });
  return { residentId: draft.residentId, purpose, adapterId, credentialId };
}

async function collectBindings(options: RunInstallerOptions, draft: InstallerDraft): Promise<void> {
  const bindings: ChannelBinding[] = [await chooseBinding(options, draft, "main")];
  if (
    await options.prompt.confirm({ message: "Configure a separate coding channel?", default: true })
  ) {
    bindings.push(await chooseBinding(options, draft, "coding"));
  }
  options.controller.saveBindings(bindings);
}

async function collectFrontend(options: RunInstallerOptions): Promise<void> {
  const kind = await options.prompt.select<FrontendChoice["kind"]>({
    message: "Frontend",
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
    message: "Memory library",
    choices: [
      { value: "existing", name: "Use an existing memory library" },
      { value: "create", name: "Create an empty memory library" },
    ],
    default: "create",
  });
  const path = await options.prompt.input({
    message: kind === "existing" ? "Existing memory path" : "New memory path",
    default: join(options.dataDir, "memory"),
  });
  if (kind === "existing") {
    options.memoryLibraries.assertExisting(path);
    options.controller.saveMemory({ kind, path });
    return;
  }
  options.memoryLibraries.createEmpty(path);
  try {
    options.controller.saveMemory({ kind, path });
  } catch (error) {
    options.memoryLibraries.discardEmpty(path);
    throw error;
  }
}

export async function runInstaller(options: RunInstallerOptions): Promise<RunInstallerResult> {
  const existing = options.store.loadDraft();
  const current = options.store.loadCurrentConfig();
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
  if (existing !== null && choice === "discard" && existing.memory?.kind === "create") {
    options.memoryLibraries.discardEmpty(existing.memory.path);
  }
  let draft = options.controller.start(options.residentId, choice);

  while (true) {
    switch (draft.progress.currentStep) {
      case "credentials":
        await collectCredentials(options);
        break;
      case "bindings":
        await collectBindings(options, draft);
        break;
      case "frontend":
        await collectFrontend(options);
        break;
      case "memory":
        await collectMemory(options);
        break;
      case "review": {
        if (draft.frontend?.kind === "official-skin" && draft.frontend.installation === "pending") {
          options.prompt.info(
            "The official skin is not installed: issues #49 and #51 are still pending. This draft was kept and no active config changed.",
          );
          return { status: "dependency-pending", draft, dependencies: ["#49", "#51"] };
        }
        const shouldCommit = await options.prompt.confirm({
          message: "Save this setup?",
          default: true,
        });
        if (!shouldCommit) return { status: "paused", draft };
        return { status: "committed", receipt: options.controller.commit() };
      }
    }
    draft = options.controller.current();
  }
}
