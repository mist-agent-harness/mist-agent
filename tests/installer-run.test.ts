import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { residentCommand } from "../src/installer/cli.ts";
import { InstallerController } from "../src/installer/controller.ts";
import { FileMemoryLibrary } from "../src/installer/memory-library.ts";
import type { OAuthLoginPort } from "../src/installer/pi-login.ts";
import type { PromptPort } from "../src/installer/prompt-port.ts";
import { PROVIDERS, credentialTypeFor, providerById } from "../src/installer/providers.ts";
import { runInstaller } from "../src/installer/run.ts";
import { InstallerStateStore } from "../src/installer/state-store.ts";
import { ResidentIdentityStore } from "../src/resident-continuity/identity-store.ts";
import type { ModelCompletionRequest, ModelTransport } from "../src/resident-runtime/channels.ts";
import { parseResidentCliArguments, main as residentMain } from "../src/resident-runtime/cli.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";

const temporaryDirectories: string[] = [];

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-installer-run-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ScriptedPrompt implements PromptPort {
  readonly #selects: string[];
  readonly #inputs: string[];
  readonly #secrets: string[];
  readonly #confirms: boolean[];
  readonly infoMessages: string[] = [];

  constructor(options: {
    selects: string[];
    inputs: string[];
    secrets: string[];
    confirms: boolean[];
  }) {
    this.#selects = [...options.selects];
    this.#inputs = [...options.inputs];
    this.#secrets = [...options.secrets];
    this.#confirms = [...options.confirms];
  }

  async select<Value extends string>(): Promise<Value> {
    const value = this.#selects.shift();
    if (value === undefined) throw new Error("missing scripted select answer");
    return value as Value;
  }

  async input(): Promise<string> {
    const value = this.#inputs.shift();
    if (value === undefined) throw new Error("missing scripted input answer");
    return value;
  }

  async secret(): Promise<string> {
    const value = this.#secrets.shift();
    if (value === undefined) throw new Error("missing scripted secret answer");
    return value;
  }

  async confirm(): Promise<boolean> {
    const value = this.#confirms.shift();
    if (value === undefined) throw new Error("missing scripted confirm answer");
    return value;
  }

  info(message: string): void {
    this.infoMessages.push(message);
  }

  expectExhausted(): void {
    expect(this.#selects).toEqual([]);
    expect(this.#inputs).toEqual([]);
    expect(this.#secrets).toEqual([]);
    expect(this.#confirms).toEqual([]);
  }
}

const noOAuth: OAuthLoginPort = {
  async login() {
    throw new Error("OAuth was not expected in this test");
  },
};

/**
 * 安装器只提交 config/current.json/快照，不做 D22 住户自认（#182）。安装器集成
 * 测试用这个帮手显式构造一个 synthetic accepted candidate，让 runtime 真的走到
 * 凭证面。这不是安装路径的一部分，也不代表安装器会替住户签「我是谁」——只是把
 * 判卷夹具推过身份闸，使 credential-missing / invalid / secret-read 分支确实
 * 有机会发生（否则测试会被 resident-not-found 提前挡住，测不到真正要看的行为）。
 */
function activateSyntheticResident(dataDir: string, residentId: string): { candidateId: string } {
  const identities = new ResidentIdentityStore({ dataDir: join(dataDir, "identities") });
  const candidate = identities.createCandidate({
    persona: `persona:${residentId}`,
    proposedBy: { kind: "installer", id: "installer-run-test" },
    residentId,
  });
  const attested = identities.attestCandidate(
    candidate.candidateId,
    { kind: "candidate", candidateId: candidate.candidateId },
    "accepted",
  );
  if (!attested.ok || attested.value.residentId !== residentId) {
    throw new Error(`failed to activate synthetic resident ${residentId}`);
  }
  return { candidateId: candidate.candidateId };
}

function apiKeyRef(id: string) {
  return { id, type: "api_key" as const, issuerId: "mist-installer-api-key" };
}

function oauthRef(id: string, type: "claude_oauth" | "codex_oauth" | "grok_oauth") {
  return { id, type, issuerId: "pi" };
}

describe.each([
  { frontend: "external", memory: "existing", expectedStatus: "committed" },
  { frontend: "external", memory: "create", expectedStatus: "committed" },
  { frontend: "official-skin", memory: "existing", expectedStatus: "dependency-pending" },
  { frontend: "official-skin", memory: "create", expectedStatus: "dependency-pending" },
] as const)("installer runner: $frontend + $memory", ({ frontend, memory, expectedStatus }) => {
  it("finishes safely without leaking credential text", async () => {
    const directory = freshDirectory();
    const store = new InstallerStateStore(directory);
    const memoryPath = join(directory, "memory-choice");
    if (memory === "existing") mkdirSync(memoryPath);
    const prompt = new ScriptedPrompt({
      selects:
        frontend === "official-skin"
          ? ["codex", "api-key", "codex-key", frontend, memory, "keep"]
          : ["codex", "api-key", "codex-key", frontend, memory],
      inputs: ["codex-key", memoryPath],
      secrets: ["credential-text"],
      confirms: frontend === "external" ? [false, false, true] : [false, false],
    });
    const result = await runInstaller({
      residentId: "resident-1",
      dataDir: directory,
      controller: new InstallerController(store),
      store,
      prompt,
      oauth: noOAuth,
      memoryLibraries: new FileMemoryLibrary(),
    });

    expect(result.status).toBe(expectedStatus);
    if (result.status === "committed") {
      expect(result.receipt.config.frontend.kind).toBe(frontend);
      expect(result.receipt.config.memory.kind).toBe(memory);
      expect(JSON.stringify(result.receipt.config)).not.toContain("credential-text");
      expect(store.readCredentialSecret("codex-key")).toBe("credential-text");
    } else if (result.status === "dependency-pending") {
      expect(result.draft.frontend?.kind).toBe("official-skin");
      expect(result.draft.memory?.kind).toBe(memory);
      expect(store.loadCurrentConfig()).toBeNull();
      expect(store.loadDraft()?.progress.currentStep).toBe("review");
    }
    expect(existsSync(memoryPath)).toBe(true);
    prompt.expectExhausted();
  });
});

it("writes primary Pi and coding Claude SDK bindings to separate lanes", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const prompt = new ScriptedPrompt({
    selects: [
      "codex",
      "api-key",
      "claude",
      "oauth",
      "codex-key",
      "claude-login",
      "codex-key",
      "external",
      "create",
    ],
    inputs: [
      "codex-key",
      "claude-login",
      "https://gateway.example.test",
      join(directory, "memory"),
    ],
    secrets: ["codex-api-key"],
    confirms: [true, false, true, true, true],
  });
  const oauth: OAuthLoginPort = {
    async login() {
      return { locator: "pi-auth://anthropic" };
    },
  };

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error("expected committed setup");
  expect(result.receipt.config.bindings).toEqual([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("codex-key"),
    },
    {
      residentId: "resident-1",
      lane: "coding",
      adapterId: "claude-agent-sdk",
      credentialRef: oauthRef("claude-login", "claude_oauth"),
      adapterConfig: {
        baseUrl: "https://gateway.example.test",
        tokenCredentialRef: apiKeyRef("codex-key"),
      },
    },
  ]);
  prompt.expectExhausted();
});

it("keeps Grok OAuth out of the v0 installer acquisition catalog", () => {
  const grok = PROVIDERS.find((provider) => provider.id === "grok");

  expect(grok?.piAuthKey).toBe("xai");
  expect(grok?.methods).toEqual(["api-key"]);
});

it("offers OpenRouter and Kimi Code by API key only, under pi's provider names", () => {
  const openrouter = providerById("openrouter");
  const kimi = providerById("kimi");

  expect(openrouter.piAuthKey).toBe("openrouter");
  expect(kimi.piAuthKey).toBe("kimi-coding");
  expect(openrouter.methods).toEqual(["api-key"]);
  expect(kimi.methods).toEqual(["api-key"]);
  expect(credentialTypeFor(openrouter, "api-key")).toBe("api_key");
  expect(() => credentialTypeFor(kimi, "oauth")).toThrow(/no OAuth credential type/);
});

it("defaults the frontend step to the choice that can be saved today", async () => {
  const directory = freshDirectory();
  const memoryPath = join(directory, "memory");
  mkdirSync(memoryPath);
  const store = new InstallerStateStore(directory);
  const defaults = new Map<string, string | undefined>();
  class RecordingPrompt extends ScriptedPrompt {
    override async select<Value extends string>(options?: {
      message: string;
      default?: Value;
    }): Promise<Value> {
      if (options !== undefined) defaults.set(options.message, options.default);
      return super.select<Value>();
    }
  }
  const prompt = new RecordingPrompt({
    selects: ["openrouter", "api-key", "openrouter-key", "external", "existing"],
    inputs: ["openrouter-key", memoryPath],
    secrets: ["synthetic-frontend-default-secret"],
    confirms: [false, false, true],
  });

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  expect(defaults.get("Step 3/4 · Frontend")).toBe("external");
});

it("replaces a credential when the user enters the same name twice", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const memoryPath = join(directory, "memory");
  mkdirSync(memoryPath);
  const prompt = new ScriptedPrompt({
    selects: ["codex", "api-key", "codex", "api-key", "codex-key", "external", "existing"],
    inputs: ["codex-key", "codex-key", memoryPath],
    secrets: ["first-secret", "replacement-secret"],
    confirms: [true, false, false, true],
  });

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error("expected committed setup");
  expect(result.receipt.config.credentialRefs).toEqual([apiKeyRef("codex-key")]);
  expect(store.readCredentialSecret("codex-key")).toBe("replacement-secret");
  expect(prompt.infoMessages).toContain('Replaced existing credential "codex-key".');
  prompt.expectExhausted();
});

it("resumes from the persisted next step instead of asking for credentials again", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const first = new InstallerController(store);
  first.start("resident-1");
  first.saveCredentials([
    {
      credential: {
        ref: oauthRef("codex-login", "codex_oauth"),
        label: "Codex",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "pi-auth://openai-codex",
    },
  ]);

  const prompt = new ScriptedPrompt({
    selects: ["resume", "codex-login", "external", "create"],
    inputs: [join(directory, "memory")],
    secrets: [],
    confirms: [false, true],
  });
  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  prompt.expectExhausted();
});

it("returns to credentials when the primary lane has no compatible credential", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const first = new InstallerController(store);
  first.start("resident-1");
  first.saveCredentials([
    {
      credential: {
        ref: oauthRef("claude-login", "claude_oauth"),
        label: "Claude login",
        providerId: "claude",
        status: "incomplete",
      },
      secret: "pi-auth://anthropic",
    },
  ]);

  const prompt = new ScriptedPrompt({
    selects: ["resume", "codex", "api-key", "codex-key", "claude-login", "external", "create"],
    inputs: ["Codex key", join(directory, "memory")],
    secrets: ["codex-secret"],
    confirms: [false, true, false, true],
  });
  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error("expected committed setup");
  expect(result.receipt.config.credentialRefs).toEqual([
    oauthRef("claude-login", "claude_oauth"),
    apiKeyRef("codex-key"),
  ]);
  expect(result.receipt.config.bindings.map((binding) => binding.lane)).toEqual([
    "primary",
    "coding",
  ]);
  expect(prompt.infoMessages).toContain(
    "No saved credential can be used with pi. Add one now — your draft is kept.",
  );
  prompt.expectExhausted();
});

it("keeps the exact review draft when commit is declined", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const controller = new InstallerController(store);
  controller.start("resident-1");
  controller.saveCredentials([
    {
      credential: {
        ref: apiKeyRef("codex-key"),
        label: "Codex",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "credential-text",
    },
  ]);
  controller.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("codex-key"),
    },
  ]);
  controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
  controller.saveMemory({ kind: "create", path: join(directory, "memory") });

  const prompt = new ScriptedPrompt({
    selects: ["resume"],
    inputs: [],
    secrets: [],
    confirms: [false],
  });
  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("paused");
  expect(store.loadDraft()?.progress.currentStep).toBe("review");
  expect(prompt.infoMessages.join("\n")).toContain("primary: pi · codex-key");
  expect(prompt.infoMessages.join("\n")).not.toContain("credential-text");
  prompt.expectExhausted();
});

it("lets a pending official-skin draft switch to an external frontend without redoing memory", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const memoryPath = join(directory, "memory");
  const libraries = new FileMemoryLibrary();
  const first = new InstallerController(store);
  first.start("resident-1");
  first.saveCredentials([
    {
      credential: {
        ref: apiKeyRef("codex-key"),
        label: "Codex",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "credential-text",
    },
  ]);
  first.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("codex-key"),
    },
  ]);
  first.saveFrontend({
    kind: "official-skin",
    pluginId: "mist-official-skin",
    installation: "pending",
  });
  const reviewDraft = first.saveMemory({ kind: "create", path: memoryPath });
  libraries.createEmpty(memoryPath, reviewDraft.draftId);

  const prompt = new ScriptedPrompt({
    selects: ["resume", "change", "external"],
    inputs: [],
    secrets: [],
    confirms: [true],
  });
  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: libraries,
  });

  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error("expected committed setup");
  expect(result.receipt.config.frontend).toEqual({
    kind: "external",
    integration: "mist-session-api",
  });
  expect(result.receipt.config.memory.path).toBe(memoryPath);
  prompt.expectExhausted();
});

it("keeps an existing installation by default instead of creating a second snapshot", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const controller = new InstallerController(store);
  controller.start("resident-1");
  controller.saveCredentials([
    {
      credential: {
        ref: apiKeyRef("codex-key"),
        label: "Codex",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "credential-text",
    },
  ]);
  controller.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("codex-key"),
    },
  ]);
  controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
  controller.saveMemory({ kind: "create", path: join(directory, "memory") });
  const first = controller.commit();

  const prompt = new ScriptedPrompt({
    selects: ["keep"],
    inputs: [],
    secrets: [],
    confirms: [],
  });
  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("already-configured");
  expect(store.loadCurrentConfig()).toEqual(first.config);
  prompt.expectExhausted();
});

it("removes an untouched installer-created memory library when its draft is discarded", async () => {
  const directory = freshDirectory();
  const memoryPath = join(directory, "old-memory");
  const store = new InstallerStateStore(directory);
  const libraries = new FileMemoryLibrary();
  const old = new InstallerController(store);
  old.start("resident-1");
  old.saveCredentials([
    {
      credential: {
        ref: apiKeyRef("old-key"),
        label: "Old",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "old-secret",
    },
  ]);
  old.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("old-key"),
    },
  ]);
  old.saveFrontend({ kind: "external", integration: "mist-session-api" });
  const reviewDraft = old.saveMemory({ kind: "create", path: memoryPath });
  libraries.createEmpty(memoryPath, reviewDraft.draftId);

  const replacementPath = join(directory, "replacement-memory");
  const prompt = new ScriptedPrompt({
    selects: ["discard", "codex", "api-key", "new-key", "external", "create"],
    inputs: ["new-key", replacementPath],
    secrets: ["new-secret"],
    confirms: [false, false, true],
  });
  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: libraries,
  });

  expect(result.status).toBe("committed");
  expect(existsSync(memoryPath)).toBe(false);
  expect(existsSync(replacementPath)).toBe(true);
  prompt.expectExhausted();
});

it("does not delete the active memory library when a same-path replacement draft is discarded", async () => {
  const directory = freshDirectory();
  const memoryPath = join(directory, "active-memory");
  const store = new InstallerStateStore(directory);
  const libraries = new FileMemoryLibrary();

  const active = new InstallerController(store);
  active.start("resident-1");
  active.saveCredentials([
    {
      credential: {
        ref: apiKeyRef("active-key"),
        label: "Active",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "active-secret",
    },
  ]);
  active.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("active-key"),
    },
  ]);
  active.saveFrontend({ kind: "external", integration: "mist-session-api" });
  const activeDraft = active.saveMemory({ kind: "create", path: memoryPath });
  libraries.createEmpty(memoryPath, activeDraft.draftId);
  active.commit();

  const abandoned = new InstallerController(store);
  abandoned.start("resident-1");
  abandoned.saveCredentials([
    {
      credential: {
        ref: apiKeyRef("abandoned-key"),
        label: "Abandoned",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "abandoned-secret",
    },
  ]);
  abandoned.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("abandoned-key"),
    },
  ]);
  abandoned.saveFrontend({ kind: "external", integration: "mist-session-api" });
  const abandonedDraft = abandoned.saveMemory({ kind: "create", path: memoryPath });
  libraries.createEmpty(memoryPath, abandonedDraft.draftId);

  const prompt = new ScriptedPrompt({
    selects: ["discard", "codex", "api-key", "replacement-key", "external", "existing"],
    inputs: ["replacement-key", memoryPath],
    secrets: ["replacement-secret"],
    confirms: [false, false, true],
  });
  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: libraries,
  });

  expect(result.status).toBe("committed");
  expect(existsSync(memoryPath)).toBe(true);
  expect(store.loadCurrentConfig()?.memory).toEqual({ kind: "existing", path: memoryPath });
  prompt.expectExhausted();
});

// ── #58 第 1、2 条：恢复路径的两个死锁 ──────────────────────────────

function reviewReadyDraft(
  store: InstallerStateStore,
  overrides: {
    credentials: { ref: ReturnType<typeof apiKeyRef>; label: string }[];
    memory: { kind: "existing" | "create"; path: string };
    bindingResidentId?: string;
  },
): void {
  const seeded = new InstallerController(store);
  const draft = seeded.start("resident-1");
  store.saveDraft({
    ...draft,
    credentials: overrides.credentials.map((entry) => ({
      ref: entry.ref,
      label: entry.label,
      providerId: "codex",
      status: "ready",
    })),
    bindings: [
      {
        residentId: overrides.bindingResidentId ?? "resident-1",
        lane: "primary",
        adapterId: "pi",
        credentialRef: overrides.credentials[0]?.ref ?? apiKeyRef("codex-key"),
      },
    ],
    frontend: { kind: "external", integration: "mist-session-api" },
    memory: overrides.memory,
    progress: {
      currentStep: "review",
      status: "in-progress",
      completedSteps: ["credentials", "bindings", "frontend", "memory"],
    },
  });
}

it("saveCredentials rejects a duplicate id instead of leaving it for commit", () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const controller = new InstallerController(store);
  const draft = controller.start("resident-1");

  expect(() =>
    controller.saveCredentials([
      {
        credential: {
          ref: apiKeyRef("codex-key"),
          label: "First",
          providerId: "codex",
          status: "incomplete",
        },
        secret: "first-secret",
      },
      {
        credential: {
          ref: apiKeyRef("codex-key"),
          label: "Second",
          providerId: "codex",
          status: "incomplete",
        },
        secret: "second-secret",
      },
    ]),
  ).toThrow(/duplicate credential id: codex-key/);

  // Rejected before staging: no orphan secret, and the draft stays on step 1.
  expect(store.hasStagedSecret(draft.draftId, "codex-key.credential")).toBe(false);
  expect(store.loadDraft()?.progress.currentStep).toBe("credentials");
});

it("offers a way back to credentials when commit rejects a draft written by an older build", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const memoryPath = join(directory, "memory-choice");
  mkdirSync(memoryPath);
  // saveCredentials now refuses this shape, but drafts written before the fix are
  // still on disk; commit stays the last line of defence and must not be a dead end.
  reviewReadyDraft(store, {
    credentials: [
      { ref: apiKeyRef("codex-key"), label: "First" },
      { ref: apiKeyRef("codex-key"), label: "Second" },
    ],
    memory: { kind: "existing", path: memoryPath },
  });

  const prompt = new ScriptedPrompt({
    // review confirm -> commit throws -> back to credentials -> redo steps 1..2.
    // Frontend and memory are not asked again: they stay completed, which is exactly
    // why rewinding to frontend could never clear a bad memory path (see #58 item 2).
    selects: ["resume", "fix", "codex", "api-key", "codex-key"],
    inputs: ["codex-key"],
    secrets: ["credential-text"],
    confirms: [true, false, false, true],
  });

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  expect(prompt.infoMessages.some((message) => message.includes("duplicate credential id"))).toBe(
    true,
  );
  expect(store.loadCurrentConfig()?.credentialRefs).toHaveLength(1);
  prompt.expectExhausted();
});

it("keeps the draft when a rejected commit is not fixed on the spot", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const memoryPath = join(directory, "memory-choice");
  mkdirSync(memoryPath);
  reviewReadyDraft(store, {
    credentials: [
      { ref: apiKeyRef("dup"), label: "First" },
      { ref: apiKeyRef("dup"), label: "Second" },
    ],
    memory: { kind: "existing", path: memoryPath },
  });

  const prompt = new ScriptedPrompt({
    selects: ["resume", "keep"],
    inputs: [],
    secrets: [],
    confirms: [true],
  });

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("paused");
  expect(store.loadCurrentConfig()).toBeNull();
  expect(store.loadDraft()?.credentials).toHaveLength(2);
  prompt.expectExhausted();
});

it("lets the user pick another path when the memory library location is occupied", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const occupied = join(directory, "occupied-memory");
  const replacement = join(directory, "fresh-memory");
  // A directory mist did not create: no marker, so createEmpty refuses to adopt it.
  // This is the state a resume finds after the first attempt failed on that path.
  mkdirSync(occupied);
  mkdirSync(join(occupied, "someone-elses-data"));
  // Built through the normal API: the draft records the create path but the
  // directory was never made by mist, which is what a resume finds after the
  // first attempt failed on that path.
  const seeded = new InstallerController(store);
  seeded.start("resident-1");
  seeded.saveCredentials([
    {
      credential: {
        ref: apiKeyRef("codex-key"),
        label: "Codex",
        providerId: "codex",
        status: "incomplete",
      },
      secret: "credential-text",
    },
  ]);
  seeded.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: apiKeyRef("codex-key"),
    },
  ]);
  seeded.saveFrontend({ kind: "external", integration: "mist-session-api" });
  seeded.saveMemory({ kind: "create", path: occupied });

  const prompt = new ScriptedPrompt({
    // resume lands on review -> createEmpty fails -> memory step again -> new path
    selects: ["resume", "create"],
    inputs: [replacement],
    secrets: [],
    confirms: [true],
  });

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  expect(prompt.infoMessages.some((message) => message.includes("cannot be created"))).toBe(true);
  expect(store.loadCurrentConfig()?.memory).toEqual({ kind: "create", path: replacement });
  expect(existsSync(join(replacement, ".mist-memory.json"))).toBe(true);
  // The occupied directory is left exactly as it was.
  expect(existsSync(join(occupied, "someone-elses-data"))).toBe(true);
  prompt.expectExhausted();
});

it("a binding rejection at commit sends the user to bindings and keeps the credentials", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const memoryPath = join(directory, "memory-choice");
  mkdirSync(memoryPath);
  // The credential set is fine; only the binding names the wrong resident. Review
  // must not answer that by throwing away the credential (independent review of #74).
  reviewReadyDraft(store, {
    credentials: [{ ref: apiKeyRef("codex-key"), label: "Codex" }],
    memory: { kind: "existing", path: memoryPath },
    bindingResidentId: "different-resident",
  });
  store.stageSecret(store.loadDraft()?.draftId ?? "", "codex-key.credential", "credential-text");

  const prompt = new ScriptedPrompt({
    // review confirm -> commit throws (binding) -> back to bindings -> redo bindings only:
    // pick the (still present) credential, decline a coding channel, confirm review.
    selects: ["resume", "fix", "codex-key"],
    inputs: [],
    secrets: [],
    confirms: [true, false, true],
  });

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  expect(
    prompt.infoMessages.some((message) => message.includes("does not match draft resident")),
  ).toBe(true);
  // The credential survived the round trip untouched: same id, same secret.
  expect(store.loadCurrentConfig()?.credentialRefs.map((ref) => ref.id)).toEqual(["codex-key"]);
  expect(store.readCredentialSecret("codex-key")).toBe("credential-text");
  prompt.expectExhausted();
});

it("a second occupied memory path is caught at the memory step instead of crashing", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const occupiedA = join(directory, "occupied-a");
  const occupiedB = join(directory, "occupied-b");
  const replacement = join(directory, "fresh-memory");
  mkdirSync(join(occupiedA, "data"), { recursive: true });
  mkdirSync(join(occupiedB, "data"), { recursive: true });

  const prompt = new ScriptedPrompt({
    // step 1..3, then memory: occupied A (caught) -> occupied B (caught) -> fresh
    selects: ["codex", "api-key", "codex-key", "external", "create", "create", "create"],
    inputs: ["codex-key", occupiedA, occupiedB, replacement],
    secrets: ["credential-text"],
    confirms: [false, false, true],
  });

  const result = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });

  expect(result.status).toBe("committed");
  expect(
    prompt.infoMessages.filter((message) => message.includes("cannot be created")),
  ).toHaveLength(2);
  expect(store.loadCurrentConfig()?.memory).toEqual({ kind: "create", path: replacement });
  expect(existsSync(join(occupiedA, "data"))).toBe(true);
  expect(existsSync(join(occupiedB, "data"))).toBe(true);
  prompt.expectExhausted();
});

it("does not send a committed installer user back through setup or silently activate a resident", async () => {
  const directory = freshDirectory();
  const memoryPath = join(directory, "memory");
  mkdirSync(memoryPath);
  const store = new InstallerStateStore(directory);
  const residentId = "resident-install-boundary";
  const secret = "synthetic-install-boundary-secret";
  const prompt = new ScriptedPrompt({
    selects: ["codex", "api-key", "codex-key", "external", "existing"],
    inputs: ["codex-key", memoryPath],
    secrets: [secret],
    confirms: [false, false, true],
  });
  const installed = await runInstaller({
    residentId,
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });
  if (installed.status !== "committed") throw new Error("installer did not commit");
  prompt.expectExhausted();
  expect(store.loadCurrentConfig()?.residentId).toBe(residentId);
  expect(store.readCredentialSecret("codex-key")).toBe(secret);
  const currentBefore = readFileSync(join(directory, "current.json"), "utf8");
  const configPath = join(directory, "snapshots", installed.receipt.snapshotId, "config.json");
  const configBefore = readFileSync(configPath, "utf8");

  const credentialsDir = join(directory, "credentials");
  const residentsDir = join(directory, "residents");
  const identitiesDir = join(directory, "identities");
  const streamPath = join(directory, "streams", `${residentId}.stream.json`);

  const runCli = (reference: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/resident-runtime/cli.ts", import.meta.url)),
        "--resident",
        reference,
        "--data-dir",
        directory,
      ],
      {
        input: "hello-from-installer\n/exit\n",
        encoding: "utf8",
        env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
        timeout: 15_000,
      },
    );

  // —— 第一段：真实安装后的状态，不创建、不自签任何 candidate ——
  // 安装器只提交 config/current.json/快照，不做 D22 住户自认（#182）。真实负例必须
  // 证明「安装提交本身没有激活住户」：CLI 以真实 residentId 启动，身份闸 resident-not-found。
  const beforeActivation = runCli(residentId);
  expect(beforeActivation.error).toBeUndefined();
  expect(beforeActivation.status, beforeActivation.stderr).toBe(1);
  expect(beforeActivation.stderr).toContain("resident-not-found");
  expect(beforeActivation.stderr).toContain("处理建议：");
  expect(beforeActivation.stderr).toContain("persona candidate");
  // 身份账未被安装器或 CLI 自动创建 resident：residents/ 为空，身份注册表里没有住户。
  // （CLI 构造运行时会在 identities/ 下建目录，但空账不等于「已激活住户」。）
  expect(readdirSync(residentsDir)).toEqual([]);
  const registryPath = join(identitiesDir, "registry.json");
  if (existsSync(registryPath)) {
    expect(readFileSync(registryPath, "utf8")).not.toContain(residentId);
  }
  // runtime 凭证面缺席：安装的凭证没有被复制进门；无流、无模型回声。
  expect(existsSync(join(credentialsDir, "manifest.json"))).toBe(false);
  expect(readdirSync(join(credentialsDir, "secrets"))).toEqual([]);
  expect(existsSync(streamPath)).toBe(false);
  expect(beforeActivation.stdout).not.toContain("合成回声已读来信。");
  expect(beforeActivation.stdout + beforeActivation.stderr).not.toContain(secret);
  // 安装负例：原 config/snapshot/secret 字节保持。
  expect(readFileSync(join(directory, "current.json"), "utf8")).toBe(currentBefore);
  expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  expect(store.readCredentialSecret("codex-key")).toBe(secret);

  // —— 第二段：显式 synthetic self-attestation 后走 candidateId 到 credential-missing ——
  // 明确造一个 accepted candidate 把住户推过身份闸，才能确实到达 credential-missing
  // 分支——否则只会停在 resident-not-found，测不到 runtime 凭证面的诊断。
  const { candidateId } = activateSyntheticResident(directory, residentId);
  // 落盘档案由 runtime 构造时从身份账 materialize；先建一次拿基线字节。
  const seed = new ResidentRuntime({ dataDir: directory });
  await seed.close();
  const roomBefore = readFileSync(join(directory, "residents", `${residentId}.json`), "utf8");

  // Prompt IO is scripted, but commit, storage and the fresh CLI process are production paths.
  const child = runCli(candidateId); // CLI 边界 resolve 一次；runtime 只认 canonical residentId。
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("credential-missing");
  expect(child.stdout).toContain("尚未接到");
  expect(child.stdout).toContain("重复运行 setup");
  expect(child.stdout).not.toContain("安装器 npm run setup，或 provisionChannel");
  expect(child.stdout + child.stderr).not.toContain(secret);
  expect(child.stdout).not.toContain("合成回声已读来信。");
  // 安装负例：凭证面未被安装快照复制或自签。
  expect(existsSync(join(credentialsDir, "manifest.json"))).toBe(false);
  expect(readdirSync(join(credentialsDir, "secrets"))).toEqual([]);
  // 第二段只物化这次显式自认的同一户：档案字节稳定；认证账装配可另建同户 .facts.json。
  // 账文件不是第二位住户，不应把 room+账的合法物化误判为自动激活；其他文件仍拒绝。
  expect(readdirSync(residentsDir).filter((file) => file !== `${residentId}.facts.json`)).toEqual([
    `${residentId}.json`,
  ]);
  expect(readFileSync(join(residentsDir, `${residentId}.json`), "utf8")).toBe(roomBefore);
  // 身份闸真在跑：candidateId 不是 runtime 别名，runtime 只认 canonical residentId。
  const identities = new ResidentIdentityStore({ dataDir: identitiesDir });
  expect(identities.requireResident(candidateId).ok).toBe(false);
  expect(identities.requireResident(residentId)).toMatchObject({
    ok: true,
    value: { residentId },
  });
  expect(existsSync(streamPath)).toBe(false);
  // 安装负例：原 config/snapshot/secret 字节保持。
  expect(readFileSync(join(directory, "current.json"), "utf8")).toBe(currentBefore);
  expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  expect(store.readCredentialSecret("codex-key")).toBe(secret);
});

/** 录下每次请求，按顺序吐出预设回答。 */
class ScriptedTransport implements ModelTransport {
  readonly requests: ModelCompletionRequest[] = [];
  readonly #replies: string[];
  constructor(replies: string[]) {
    this.#replies = [...replies];
  }
  async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
    const { onUsage: _onUsage, ...serializable } = request;
    this.requests.push(structuredClone(serializable));
    const reply = this.#replies.shift() ?? "";
    yield reply.slice(0, 1);
    yield reply.slice(1);
  }
}

async function* scriptedLines(lines: readonly string[]): AsyncGenerator<string> {
  yield* lines;
}

/** 在本进程里跑一次 `npm run resident`，收下它写给终端的全部文字。 */
async function runResident(
  args: string[],
  transport: ModelTransport,
  lines: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const output: string[] = [];
  const capture = (chunk: unknown): boolean => {
    output.push(String(chunk));
    return true;
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await residentMain(args, { transport, lines: scriptedLines(lines) });
    return { exitCode: Number(process.exitCode ?? 0), output: output.join("") };
  } finally {
    process.exitCode = before;
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

it("goes from a committed setup to chat only after the resident itself accepts the persona", async () => {
  const directory = freshDirectory();
  const memoryPath = join(directory, "memory");
  mkdirSync(memoryPath);
  const store = new InstallerStateStore(directory);
  const secret = "synthetic-setup-to-chat-secret";
  const model = "openrouter/test-vendor/test-model";
  const prompt = new ScriptedPrompt({
    selects: ["openrouter", "api-key", "openrouter-key", "external", "existing"],
    inputs: ["openrouter-key", memoryPath],
    secrets: [secret],
    confirms: [false, false, true],
  });
  const installed = await runInstaller({
    residentId: "resident-1",
    dataDir: directory,
    controller: new InstallerController(store),
    store,
    prompt,
    oauth: noOAuth,
    memoryLibraries: new FileMemoryLibrary(),
  });
  if (installed.status !== "committed") throw new Error("installer did not commit");
  prompt.expectExhausted();
  const firstPersona = join(directory, "first.md");
  const secondPersona = join(directory, "second.md");
  writeFileSync(firstPersona, "TEST-PERSONA-ONE");
  writeFileSync(secondPersona, "TEST-PERSONA-TWO");
  const credentialsManifest = join(directory, "credentials", "manifest.json");
  const streamPath = join(directory, "streams", "resident-1.stream.json");

  // —— 负例：住户自己说不认。安装和人都不能替它认，什么都不开门 ——
  const refusing = new ScriptedTransport(["不认\n这不是我。"]);
  const refused = await runResident(
    ["--data-dir", directory, "--persona", firstPersona, "--model", model],
    refusing,
    ["你好", "/exit"],
  );
  expect(refused.exitCode).toBe(1);
  expect(refused.output).toContain("candidate-rejected");
  expect(refusing.requests).toHaveLength(1);
  expect(refusing.requests[0]?.bootPack.identity).toBe("TEST-PERSONA-ONE");
  expect(existsSync(credentialsManifest)).toBe(false);
  expect(existsSync(streamPath)).toBe(false);
  expect(readdirSync(join(directory, "residents"))).toEqual([]);

  // —— 正对照：换一份人格稿，住户第一行写「认」，同一次启动接着进聊天 ——
  const accepting = new ScriptedTransport(["认\n这份像我。", "你好，我在。"]);
  const accepted = await runResident(
    ["--data-dir", directory, "--persona", secondPersona, "--model", model],
    accepting,
    ["你好", "/exit"],
  );
  expect(accepted.exitCode, accepted.output).toBe(0);
  expect(accepting.requests.map((request) => request.text.slice(0, 2))).toEqual(["在你", "你好"]);
  expect(accepting.requests.every((request) => request.credentialSecret === secret)).toBe(true);
  expect(accepting.requests[1]?.residentId).toBe("resident-1");
  expect(accepting.requests[1]?.bootPack.identity).toContain("TEST-PERSONA-TWO");

  const reopened = new ResidentRuntime({ dataDir: directory });
  try {
    const stream = reopened.readStream({ residentId: "resident-1" });
    expect(stream.ok && stream.value.events.map((event) => [event.kind, event.text])).toEqual([
      ["user", "你好"],
      ["assistant", "你好，我在。"],
    ]);
  } finally {
    await reopened.close();
  }
  expect(JSON.parse(readFileSync(credentialsManifest, "utf8")).credentials).toMatchObject([
    { residentId: "resident-1", model, credentialKind: "api-key", status: "ready" },
  ]);
  // 不泄露：密钥只在安装快照和 runtime 凭证面，终端输出、一窗流、住户档案里都没有。
  expect(refused.output + accepted.output).not.toContain(secret);
  expect(readFileSync(streamPath, "utf8")).not.toContain(secret);
  for (const file of readdirSync(join(directory, "residents"))) {
    expect(readFileSync(join(directory, "residents", file), "utf8")).not.toContain(secret);
  }
  expect(store.readCredentialSecret("openrouter-key")).toBe(secret);
});

describe("setup's next-step command", () => {
  /** 让真 shell 拆下一步命令里 `--` 之后的词，拆出来的参数原样交给 resident 的参数解析。 */
  function residentArgumentsOf(command: string): string[] {
    const prefix = "npm run resident -- ";
    expect(command.startsWith(prefix)).toBe(true);
    return execFileSync("bash", ["-c", `printf '%s\\0' ${command.slice(prefix.length)}`])
      .toString("utf8")
      .split("\0")
      .filter((word) => word.length > 0);
  }

  it("carries a custom data directory, spaces and quotes included, through to the resident's arguments", () => {
    const dataDir = join(freshDirectory(), "my mist's data");

    const words = residentArgumentsOf(residentCommand(dataDir));

    expect(words).toEqual(["--data-dir", resolve(dataDir)]);
    expect(parseResidentCliArguments(words).dataDir).toBe(resolve(dataDir));
  });

  it("names the default directory too, so MIST_DATA_DIR pointing elsewhere cannot redirect the resident", () => {
    const defaultDir = join(homedir(), ".mist");
    vi.stubEnv("MIST_DATA_DIR", join(freshDirectory(), "another-install"));
    try {
      const words = residentArgumentsOf(residentCommand(defaultDir));
      expect(parseResidentCliArguments(words).dataDir).toBe(defaultDir);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(residentCommand("/srv/mist")).toBe("npm run resident -- --data-dir /srv/mist");
  });
});
