import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstallerController } from "../src/installer/controller.ts";
import { FileMemoryLibrary } from "../src/installer/memory-library.ts";
import type { OAuthLoginPort } from "../src/installer/pi-login.ts";
import type { PromptPort } from "../src/installer/prompt-port.ts";
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

it("records Pi as the issuer for Grok subscription OAuth", async () => {
  const directory = freshDirectory();
  const store = new InstallerStateStore(directory);
  const prompt = new ScriptedPrompt({
    selects: ["grok", "oauth", "grok-login", "external", "create"],
    inputs: ["grok-login", join(directory, "memory")],
    secrets: [],
    confirms: [false, false, true],
  });
  const oauth: OAuthLoginPort = {
    async login(provider) {
      expect(provider.piAuthKey).toBe("xai");
      return { locator: "pi-auth://xai" };
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
  expect(result.receipt.config.credentialRefs).toEqual([oauthRef("grok-login", "grok_oauth")]);
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
  first.saveMemory({ kind: "create", path: memoryPath });
  libraries.createEmpty(memoryPath);

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
  libraries.createEmpty(memoryPath);
  old.saveMemory({ kind: "create", path: memoryPath });

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
