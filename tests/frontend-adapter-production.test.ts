import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { frontendAdapterChecks } from "../acceptance/frontend-adapter-checks.ts";
import { cloneFrontendAdapterDriverBoundary } from "../acceptance/frontend-adapter-driver.ts";
import { createFrontendAdapterDriver } from "../src/frontend-adapter-acceptance-driver.ts";
import {
  LEGACY_FRONTEND_UNSUPPORTED,
  LegacyFrontendUnsupportedError,
  readLegacyOfficialSkin,
} from "../src/installer/legacy-frontend.ts";
import { InstallerStateStore } from "../src/installer/state-store.ts";

const temporaryDirectories: string[] = [];
function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-frontend-adapter-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function check(id: string) {
  const found = frontendAdapterChecks.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing check ${id}`);
  return found;
}

describe("#218 frontend adapter installer choice (FE-01)", () => {
  it("defaults to terminal and lands external explicitly on openai-compatible", async () => {
    const driver = createFrontendAdapterDriver();
    expect(await driver.runInstaller({ frontend: "default" })).toEqual({
      committed: true,
      defaulted: true,
      frontend: { kind: "terminal" },
    });
    expect(await driver.runInstaller({ frontend: "external" })).toEqual({
      committed: true,
      defaulted: false,
      frontend: { kind: "external", integration: "openai-compatible" },
    });
  });

  it("fails closed on a real persisted legacy draft without rewriting its bytes", () => {
    const directory = freshDirectory();
    const draft = {
      schemaVersion: 2,
      draftId: "legacy-draft",
      residentId: "resident-1",
      credentials: [],
      bindings: [],
      frontend: {
        kind: "official-skin",
        pluginId: "mist-official-skin",
        installation: "pending",
      },
      memory: null,
      sideEffects: [],
      progress: { currentStep: "frontend", completedSteps: [], status: "in-progress" },
    };
    const draftPath = join(directory, "installer-draft.json");
    const before = JSON.stringify(draft);
    writeFileSync(draftPath, before);
    const store = new InstallerStateStore(directory);

    let thrown: unknown;
    try {
      store.loadDraft();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LegacyFrontendUnsupportedError);
    expect((thrown as LegacyFrontendUnsupportedError).code).toBe(LEGACY_FRONTEND_UNSUPPORTED);
    expect((thrown as LegacyFrontendUnsupportedError).remedy.trim().length).toBeGreaterThan(0);
    expect(readFileSync(draftPath, "utf8")).toBe(before);
  });

  it("rejects legacy official-skin bytes with an actionable remedy and no rewrite", () => {
    const raw = JSON.stringify({
      frontend: {
        kind: "official-skin",
        pluginId: "mist-official-skin",
        installation: "pending",
      },
    });
    const result = readLegacyOfficialSkin(raw);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(LEGACY_FRONTEND_UNSUPPORTED);
    expect(result.rewritten).toBe(false);
    expect(result.bytesAfter).toBe(raw);
    expect(result.remedy.trim().length).toBeGreaterThan(0);
  });

  it("does not flag a current terminal or external snapshot as legacy", () => {
    expect(readLegacyOfficialSkin('{"frontend":{"kind":"terminal"}}').ok).toBe(true);
    expect(
      readLegacyOfficialSkin('{"frontend":{"kind":"external","integration":"openai-compatible"}}')
        .ok,
    ).toBe(true);
  });

  it("fails closed on unreadable bytes without claiming to rewrite them", () => {
    const raw = "{not valid json";
    const result = readLegacyOfficialSkin(raw);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MIST_INSTALL_CONFIG_UNREADABLE");
    expect(result.rewritten).toBe(false);
    expect(result.bytesAfter).toBe(raw);
    expect(result.remedy.trim().length).toBeGreaterThan(0);
  });
});

describe("#218 production frontend adapter (D31-1 text chat)", () => {
  for (const id of ["FE-01", "FE-02", "FE-03", "FE-04", "FE-06"]) {
    it(`passes ${id} against the real src/ engine`, async () => {
      const driver = cloneFrontendAdapterDriverBoundary(createFrontendAdapterDriver());
      const result = await check(id).run(driver);
      expect(result.passed, result.detail).toBe(true);
    });
  }

  it("keeps FE-05 red: this step rejects attachments/options as a distinct error", async () => {
    const driver = cloneFrontendAdapterDriverBoundary(createFrontendAdapterDriver());
    const result = await check("FE-05").run(driver);
    expect(result.passed).toBe(false);
  });

  it("passes FE-07 through the real frontend plugin gate + text host endpoint", async () => {
    const driver = cloneFrontendAdapterDriverBoundary(createFrontendAdapterDriver());
    const result = await check("FE-07").run(driver);
    expect(result.passed, result.detail).toBe(true);
  });

  it("runs the native Python Pipe into the real listener and assembled resident runtime", async () => {
    const driver = cloneFrontendAdapterDriverBoundary(createFrontendAdapterDriver());
    const binding = await driver.provisionBinding({
      residentId: "pipe-native",
      scopeId: "ignored",
      label: "pipe-native",
    });
    await driver.queueResidentReply(binding.bindingId, { kind: "text", text: "native-pipe-reply" });
    await driver.queueResidentReply(binding.bindingId, {
      kind: "text",
      text: "native-pipe-stream-reply",
    });
    const endpoint = await (
      driver as typeof driver & { readAdapterUrl(id: string): Promise<string> }
    ).readAdapterUrl(binding.bindingId);
    const executable = process.env.MIST_PIPE_PYTHON ?? "python3.12";
    const script = fileURLToPath(new URL("./fixtures/pipe-to-listener-check.py", import.meta.url));
    const child = spawn(executable, [script], {
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONPATH: process.env.MIST_PIPE_PYTHONPATH ?? process.env.PYTHONPATH ?? "",
        MIST_ADAPTER_URL: endpoint,
        MIST_ADAPTER_TOKEN: binding.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const [code] = (await once(child, "close")) as [number | null];
    clearTimeout(timeout);
    expect(code, stderr).toBe(0);
    const payload = JSON.parse(stdout.trim()) as {
      normal: string;
      stream_has_reply: boolean;
      stream_done_count: number;
      attachment_code: string;
      task_code: string;
      interaction_code: string;
    };
    expect(payload).toEqual({
      normal: "native-pipe-reply",
      stream_has_reply: true,
      stream_done_count: 1,
      attachment_code: "MIST_ATTACHMENT_UNSUPPORTED",
      task_code: "MIST_UTILITY_REQUEST_UNSUPPORTED",
      interaction_code: "MIST_INTERACTION_UNSUPPORTED",
    });
    const events = await driver.readCanonicalEvents(binding.bindingId);
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ["user", "native-pipe-turn"],
      ["assistant", "native-pipe-reply"],
      ["user", "native-pipe-stream"],
      ["assistant", "native-pipe-stream-reply"],
    ]);
    expect(
      events.every(
        (event) => event.residentId === binding.residentId && event.streamId === binding.streamId,
      ),
    ).toBe(true);
    await driver.reset();
  });
});
