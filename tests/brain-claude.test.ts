import { describe, expect, it } from "vitest";
import type { BootPack } from "../acceptance/driver.ts";
import {
  ClaudeBrainError,
  type ClaudeQueryMessage,
  type ClaudeQueryRequest,
  buildClaudeQueryOptions,
  createClaudeDriver,
  createClaudeReply,
} from "../demo/brain-claude.ts";

const bootPack: BootPack = {
  residentId: "resident-demo",
  identity: "雾灯（虚构演示住户）",
  commitments: ["不编造没读到的记忆"],
  memories: [
    {
      id: "memory-1",
      residentId: "resident-demo",
      content: "喜欢短句",
      supersededBy: null,
      createdAt: "2026-08-15T00:00:00.000Z",
    },
  ],
};

async function* messages(...events: ClaudeQueryMessage[]): AsyncIterable<ClaudeQueryMessage> {
  yield* events;
}

describe("Claude Agent SDK brain", () => {
  it("每次回复前读 Mist 启动包，并把 SDK 结果交回 E1 接缝", async () => {
    const requests: ClaudeQueryRequest[] = [];
    const reply = createClaudeReply({
      buildBootPack: async () => bootPack,
      runQuery: (request) => {
        requests.push(request);
        return messages({ type: "result", subtype: "success", result: "  我醒了。  " });
      },
    });

    await expect(reply("resident-demo", "你是谁？")).resolves.toBe("我醒了。");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe("你是谁？");
    expect(requests[0]?.options.systemPrompt).toContain("雾灯（虚构演示住户）");
    expect(requests[0]?.options.systemPrompt).toContain("不编造没读到的记忆");
    expect(requests[0]?.options.systemPrompt).toContain("喜欢短句");
  });

  it("把工具、MCP、skills、磁盘设置和 SDK 会话恢复全部关在通道外", () => {
    const options = buildClaudeQueryOptions(bootPack, "claude-sonnet-4-6");

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toEqual([]);
    expect(options.agents).toEqual({});
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.maxTurns).toBe(1);
    expect(options.persistSession).toBe(false);
    expect(options.model).toBe("claude-sonnet-4-6");
    expect(options).not.toHaveProperty("resume");
    expect(options).not.toHaveProperty("continue");
    expect(options).not.toHaveProperty("forkSession");
    expect(options).not.toHaveProperty("sessionId");
  });

  it("createClaudeDriver 通过延迟闭包读取刚生成的真实启动包", async () => {
    const requests: ClaudeQueryRequest[] = [];
    const driver = createClaudeDriver({
      runQuery: (request) => {
        requests.push(request);
        return messages({ type: "result", subtype: "success", result: "启动成功" });
      },
    });
    const residentId = await driver.createResident("测试住户");
    await driver.remember(residentId, "记住窗边的灯");
    await driver.commit(residentId, "回来先报平安");

    const response = await driver.say(residentId, "醒来了吗");

    expect(response.content).toBe("启动成功");
    expect(requests[0]?.options.systemPrompt).toContain("测试住户");
    expect(requests[0]?.options.systemPrompt).toContain("记住窗边的灯");
    expect(requests[0]?.options.systemPrompt).toContain("回来先报平安");
  });

  it("SDK 报错、空回复和无 result 都 fail closed，不写伪回应", async () => {
    const buildBootPack = async () => bootPack;
    const failedDriver = createClaudeDriver({
      runQuery: () =>
        messages({ type: "result", subtype: "error_during_execution", errors: ["offline"] }),
    });
    const failedResidentId = await failedDriver.createResident("失败演示住户");
    const empty = createClaudeReply({
      buildBootPack,
      runQuery: () => messages({ type: "result", subtype: "success", result: "   " }),
    });
    const missing = createClaudeReply({
      buildBootPack,
      runQuery: () => messages({ type: "system", subtype: "init" }),
    });

    await expect(failedDriver.say(failedResidentId, "hi")).rejects.toThrow(
      "Claude Agent SDK failed (error_during_execution): offline",
    );
    await expect(failedDriver.history(failedResidentId)).resolves.toEqual([]);
    await expect(empty("resident-demo", "hi")).rejects.toThrow(
      "Claude Agent SDK returned an empty reply",
    );
    await expect(missing("resident-demo", "hi")).rejects.toThrow(
      "Claude Agent SDK ended without a result message",
    );
    await expect(failedDriver.say(failedResidentId, "hi")).rejects.toBeInstanceOf(ClaudeBrainError);
  });
});
