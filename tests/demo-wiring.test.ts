import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAiChatCompletionsAdapter } from "../demo/adapters/openai.ts";
import type { ClaudeQueryRequest } from "../demo/brain-claude.ts";
import { createClaudeDemoRuntime } from "../demo/main.ts";
import type { PersistentDemoRuntime } from "../demo/runtime.ts";
import { DEMO_SEED } from "../demo/seed.ts";
import { type DemoServer, createDemoServer } from "../demo/server.ts";

const dirs: string[] = [];
const servers: DemoServer[] = [];
const runtimes: PersistentDemoRuntime[] = [];

function freshDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-demo-wiring-"));
  dirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("E2 + E3 + E4 demo wiring", () => {
  it("HTTP 对话经 Claude 通道读取 E4 seed，clear 后开新根，重启仍是同一住户", async () => {
    const dataDir = freshDir();
    const requests: ClaudeQueryRequest[] = [];
    const runQuery = async function* (request: ClaudeQueryRequest) {
      requests.push(request);
      yield { type: "result", subtype: "success", result: "小栖" };
    };
    const first = await createClaudeDemoRuntime({ dataDir, runQuery });
    runtimes.push(first);
    const residentId = first.inspect().residentId;
    const server = createDemoServer({ runtime: first, adapters: [openAiChatCompletionsAdapter] });
    servers.push(server);
    const address = await server.start(0);
    const baseUrl = `http://${address.address}:${address.port}`;

    const firstReply = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mist-demo",
        messages: [{ role: "user", content: "我希望你怎么称呼我？" }],
      }),
    });
    expect(await firstReply.json()).toMatchObject({
      choices: [{ message: { content: "小栖" } }],
    });
    expect(requests[0]?.options.systemPrompt).toContain(DEMO_SEED.name);
    expect(requests[0]?.options.systemPrompt).toContain(DEMO_SEED.memories[0]);
    expect(requests[0]?.options.systemPrompt).toContain(DEMO_SEED.commitments[0]);

    await fetch(`${baseUrl}/demo/clear`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.controlToken}` },
    });
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "mist-demo",
        messages: [{ role: "user", content: "clear 后" }],
      }),
    });
    const afterClear = (await first.inspect().driver.history(residentId)).find(
      (node) => node.role === "user" && node.content === "clear 后",
    );
    expect(afterClear?.parentId).toBeNull();

    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    first.close();
    const second = await createClaudeDemoRuntime({ dataDir, runQuery });
    runtimes.push(second);
    expect(second.inspect().residentId).toBe(residentId);
    expect(await second.inspect().driver.history(residentId)).toEqual([]);
    expect((await second.bootPack()).memories.map((memory) => memory.content)).toEqual(
      DEMO_SEED.memories,
    );
  });
});
