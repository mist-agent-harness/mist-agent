import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstallerController } from "../src/installer/controller.ts";
import { FileMemoryLibrary } from "../src/installer/memory-library.ts";
import type { OAuthLoginPort } from "../src/installer/pi-login.ts";
import type { PromptPort } from "../src/installer/prompt-port.ts";
import { PROVIDERS } from "../src/installer/providers.ts";
import { runInstaller } from "../src/installer/run.ts";
import { InstallerStateStore } from "../src/installer/state-store.ts";

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
  controller.start("resident-1");

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
  expect(existsSync(join(directory, "drafts", "secrets"))).toBe(false);
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
