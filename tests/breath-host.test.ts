import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryNode } from "../acceptance/driver.ts";
import type { CanonicalEvent } from "../src/one-stream/index.ts";
import { estimateTokens } from "../src/session/handover-letter.ts";

type HostReply = {
  requestId?: string;
  type?: string;
  pid?: number;
  ok?: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; code?: string };
};

type Notice = {
  kind?: string;
  windowId?: string;
  generation?: number;
  stage?: string;
  remnants?: string[];
  windowRecovered?: boolean;
};

type GateEvent = {
  event?: string;
  residentId?: string;
  windowId?: string;
  generation?: number | null;
  detail?: string;
};

const children: ChildProcess[] = [];
const fixture = fileURLToPath(new URL("./fixtures/breath-host.ts", import.meta.url));

function startHost(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}

function waitForReady(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`host startup timed out: ${stderr}`)), 10_000);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("message", onMessage);
    child.once("exit", onExit);

    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    function onMessage(message: HostReply) {
      if (message.type !== "ready" || typeof message.pid !== "number") return;
      cleanup();
      resolve(message.pid);
    }
    function onExit(code: number | null) {
      cleanup();
      reject(new Error(`host exited ${String(code)} before ready: ${stderr}`));
    }
  });
}

let requestSeq = 0;
function callHost<T>(child: ChildProcess, command: Record<string, unknown>): Promise<T> {
  requestSeq += 1;
  const requestId = `request-${requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`host request timed out: ${requestId}`)),
      5_000,
    );
    child.on("message", onMessage);

    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
    }
    function onMessage(message: HostReply) {
      if (message.requestId !== requestId) return;
      cleanup();
      if (message.ok === true) {
        resolve(message.value as T);
      } else {
        reject(
          new Error(`${message.error?.code ?? message.error?.name}: ${message.error?.message}`),
        );
      }
    }

    child.send?.({ ...command, requestId }, (error) => {
      if (error === null) return;
      cleanup();
      reject(error);
    });
  });
}

async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await callHost(child, { op: "stop" });
  await exited;
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      try {
        await stopHost(child);
      } catch {
        child.kill();
      }
    }),
  );
});

function draft(title: string, body: string) {
  return {
    title,
    state: [{ tier: "fact", body: `状态半：${body}` }],
    intent: [{ tier: "judgment", body: `意图半：${body}` }],
  };
}

type Opened = { windowId: string; generation: number };
type Said = { node: HistoryNode; prompt: string };

describe("换气阈值硬闸与手动入口（real host subprocess）", () => {
  it("MV-D01 阈值硬闸 + 回合容差：过线回合跑完，下一回合被拦，换气后放行", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d01" });
    await callHost(child, { op: "configureThreshold", windowId, tokens: 10 });

    // 撞线的那一轮（含其回应）完整跑完——硬闸不当场腰斩（容差）。
    const first = await callHost<Said>(child, {
      op: "say",
      windowId,
      message: "第一句话，长度足够把本代用量顶过线",
    });
    expect(first.node.role).toBe("assistant");
    const usage = await callHost<number>(child, { op: "usage", windowId });
    expect(usage).toBeGreaterThanOrEqual(10);

    // 下一回合不许开始：硬闸在回合边界拦下，responders 零调用、零写入。
    await expect(
      callHost(child, { op: "say", windowId, message: "过线后的第二句" }),
    ).rejects.toThrow(/BREATH_THRESHOLD_REACHED/);
    const history = await callHost<HistoryNode[]>(child, {
      op: "history",
      residentId: "resident-d01",
    });
    expect(history).toHaveLength(2);

    // 闸事件带完整三元组（图纸 §2 的日志口径）。
    const events = await callHost<GateEvent[]>(child, { op: "events" });
    expect(events.at(-1)).toMatchObject({
      event: "threshold_reached",
      residentId: "resident-d01",
      windowId,
      generation: 1,
    });

    // 接住硬闸的宿主进同一状态机入口：写信 → 换代 → 新代醒来照常开工。
    const breathed = await callHost<Opened>(child, {
      op: "breathe",
      windowId,
      draft: draft("D01 撞线换气", "过线后写完信换代"),
    });
    expect(breathed.generation).toBe(2);
    const after = await callHost<Said>(child, {
      op: "say",
      windowId,
      message: "新代的第一句",
    });
    expect(after.node.role).toBe("assistant");
  });

  it("MV-D02 阈值只能开工时配：运行中修改一律 CONFIG_INVALID，换代后重新可配", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d02" });

    // 开工时配置：合法。
    await callHost(child, { op: "configureThreshold", windowId, tokens: 1000 });
    // 首回合过闸 → 本代配置锁定。
    await callHost<Said>(child, { op: "say", windowId, message: "先把本代开起工来" });

    // 运行中修改阈值：拒绝。临不临线同罪——锁的是动作不是差值。
    await expect(
      callHost(child, { op: "configureThreshold", windowId, tokens: 2000 }),
    ).rejects.toThrow(/CONFIG_INVALID/);
    // 形状不合法同罪。
    await expect(
      callHost(child, { op: "configureThreshold", windowId, tokens: 0 }),
    ).rejects.toThrow(/CONFIG_INVALID/);
    // 窗不在册：判不了开工状态，同罪。
    await expect(
      callHost(child, { op: "configureThreshold", windowId: "w_not_a_window", tokens: 100 }),
    ).rejects.toThrow(/CONFIG_INVALID/);

    // 换代即新一代开工：配置重新可配，且立即生效（用量 0 < 500，放行）。
    await callHost(child, {
      op: "breathe",
      windowId,
      draft: draft("D02 换代开工", "换一代再配阈值"),
    });
    await callHost(child, { op: "configureThreshold", windowId, tokens: 500 });
    const after = await callHost<Said>(child, {
      op: "say",
      windowId,
      message: "新阈值下的第一句",
    });
    expect(after.node.role).toBe("assistant");
    // 「开工时配置生效」的另一半证据在 MV-D01：阈值 10 开工时配下，过线即拦。
  });

  it("MV-D04 后半：注入新代的交接信全文不计入窗口阈值核算", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d04" });
    await callHost(child, { op: "configureThreshold", windowId, tokens: 20 });

    // 一封比阈值还肥的信：若计入核算，新代第一回合就该被拦。
    const fat = draft(
      "D04 阈值核算不含交接信的验证信，标题也参与长度",
      "这封信的正文 deliberately 写得比阈值还肥，用来区分计与不计两种口径",
    );
    const letterTokens =
      estimateTokens(fat.title) +
      estimateTokens(fat.state[0]?.body ?? "") +
      estimateTokens(fat.intent[0]?.body ?? "");
    expect(letterTokens).toBeGreaterThan(20);

    await callHost(child, { op: "breathe", windowId, draft: fat });

    // 信全文已在新代上下文里（MV-D04 前半，第二刀已勾）——它就在那儿。
    const context = await callHost<{ notes: string[]; letter?: { title: string } }>(child, {
      op: "context",
      windowId,
    });
    expect(context.letter?.title).toBe(fat.title);
    // 但用量核算不含它：读数远低于阈值，而「计入」口径下读数必然撞线。
    const usage = await callHost<number>(child, { op: "usage", windowId });
    expect(usage).toBeLessThan(20);
    expect(usage + letterTokens).toBeGreaterThan(20);

    // 行为结论：新代的第一回合照常放行，不被自己背的信顶爆。
    const after = await callHost<Said>(child, {
      op: "say",
      windowId,
      message: "背着信的第一句",
    });
    expect(after.node.role).toBe("assistant");
  });
});

describe("OS-05 宿主换气失败进入 canonical stream", () => {
  it("真实换气失败由宿主签发、明确未生效，并在下一次阈值穿越重新预告", async () => {
    const child = startHost();
    await waitForReady(child);
    const residentId = "resident-os05";
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId });

    expect(await callHost<boolean>(child, { op: "announce", windowId })).toBe(true);
    await callHost(child, { op: "failNextAppend" });
    await expect(
      callHost(child, {
        op: "breathe",
        windowId,
        draft: draft("OS-05 换气失败", "时间线写入失败，不得静默"),
      }),
    ).rejects.toThrow(/BREATH_CYCLE_FAILED\[append\]/);

    const events = await callHost<CanonicalEvent[]>(child, {
      op: "canonicalEvents",
      residentId,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      purpose: "lifecycle",
      residentId,
      authoritySource: { kind: "host", id: "mist-host" },
      origin: {
        reporter: { kind: "host", id: "mist-host" },
        subject: { kind: "viewport", id: windowId },
        viewport: { windowId, generation: 1 },
      },
      effect: {
        state: "failed-not-effective",
        requiresUserAction: false,
        retry: "automatic",
      },
      payload: {
        kind: "host-lifecycle-failed",
        action: "breath",
        stage: "append",
        reason: "injected timeline append failure",
        windowRecovered: true,
        userAction: null,
      },
    });

    // 若实现只留 BreathCycle 的本地 notice、没有主流事件，上面的长度断言直接判红。
    // 失败会清预告记号：下一次阈值穿越必须再次对人发出预告。
    expect(await callHost<boolean>(child, { op: "announce", windowId })).toBe(true);
    const notices = await callHost<Notice[]>(child, { op: "notices" });
    expect(notices.filter((notice) => notice.kind === "announced")).toHaveLength(2);
  });

  it("真实 swap 失败把需要人捞窗的动作写进 canonical stream", async () => {
    const child = startHost();
    await waitForReady(child);
    const residentId = "resident-os05-swap";
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId });

    await callHost(child, { op: "failNextSwap" });
    await expect(
      callHost(child, {
        op: "breathe",
        windowId,
        draft: draft("OS-05 换代失败", "旧窗已归档，新窗没有重开"),
      }),
    ).rejects.toThrow(/BREATH_CYCLE_FAILED\[swap\]/);

    expect(await callHost(child, { op: "archived", windowId })).toMatchObject({
      generation: 1,
      archived: true,
    });
    const events = await callHost<CanonicalEvent[]>(child, {
      op: "canonicalEvents",
      residentId,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      purpose: "lifecycle",
      residentId,
      effect: {
        state: "failed-not-effective",
        requiresUserAction: true,
        retry: "awaiting-external",
      },
      payload: {
        kind: "host-lifecycle-failed",
        action: "breath",
        stage: "swap",
        reason: "injected viewport reopen failure",
        windowRecovered: false,
        userAction: `Recover viewport ${windowId} before retrying breath`,
      },
    });
    expect(events[0]?.payload).toMatchObject({ userAction: expect.any(String) });
  });
});

describe("猝死与流水残骸（real host subprocess）", () => {
  it("MV-D07 猝死不自动注入：新代无猝死窗流水，归档查询可达", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d07" });
    await callHost<Said>(child, { op: "say", windowId, message: "猝死窗的流水甲" });
    await callHost<Said>(child, { op: "say", windowId, message: "猝死窗的流水乙" });

    // 未及写信的猝死：直接杀窗，没有 breathe、没有信。
    const archived = await callHost<{ generation: number }>(child, {
      op: "suddenKill",
      windowId,
    });
    expect(archived.generation).toBe(1);
    // 猝死代的窗归档在案（重开会消费归档槽位，归档查询要在重开前做）。
    expect(await callHost(child, { op: "archived", windowId })).toMatchObject({ generation: 1 });

    const reopened = await callHost<Opened>(child, { op: "reopen", windowId });
    expect(reopened.generation).toBe(2);

    // 新代上下文是干净的：没有信（猝死没写）、没有在途内容；
    // 猝死窗流水不进新代核算——树里明明有四条节点，用量读数是零。
    const context = await callHost<{ notes: string[] }>(child, { op: "context", windowId });
    expect(context).toEqual({ notes: [] });
    expect(await callHost<number>(child, { op: "usage", windowId })).toBe(0);

    // 归档查询可达：流水一条没少。
    const history = await callHost<HistoryNode[]>(child, {
      op: "history",
      residentId: "resident-d07",
    });
    expect(history).toHaveLength(4);
    expect(history.some((node) => node.content === "猝死窗的流水甲")).toBe(true);
    expect(history.some((node) => node.content === "猝死窗的流水乙")).toBe(true);

    // 新代照常开工。
    const after = await callHost<Said>(child, {
      op: "say",
      windowId,
      message: "猝死后的新代第一句",
    });
    expect(after.node.role).toBe("assistant");
  });

  it("MV-D07b 合法残骸降级警告并记档：连续两次换气都完成，残骸不楔死状态机", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d07b" });
    await callHost<Said>(child, { op: "say", windowId, message: "残骸测试的正常回合" });
    // 回合中途猝死的残骸：user 落了地，回应永远没落。
    await callHost(child, { op: "injectRemnant", windowId, content: "猝死在回应落地前的半句" });

    // 第一次换气：完成，且留下对人可见的残骸记档（警告档）。
    const first = await callHost<Opened>(child, {
      op: "breathe",
      windowId,
      draft: draft("D07b 带残骸换气", "末尾悬着半条回合"),
    });
    expect(first.generation).toBe(2);
    const noticesAfterFirst = await callHost<Notice[]>(child, { op: "notices" });
    const debris = noticesAfterFirst.filter((notice) => notice.kind === "debris");
    expect(debris).toHaveLength(1);
    expect(debris[0]).toMatchObject({ windowId, generation: 1 });
    expect(debris[0]?.remnants?.[0]).toMatch(/user/);

    // 第二次换气：同一份残骸不得使后续换气连续失败——它已随旧代归档。
    const second = await callHost<Opened>(child, {
      op: "breathe",
      windowId,
      draft: draft("D07b 残骸之后的再换气", "残骸没有楔死状态机"),
    });
    expect(second.generation).toBe(3);
    const noticesAfterSecond = await callHost<Notice[]>(child, { op: "notices" });
    expect(noticesAfterSecond.filter((notice) => notice.kind === "debris")).toHaveLength(1);
    expect(await callHost<unknown[]>(child, { op: "timeline" })).toHaveLength(2);
  });

  it("MV-D07b 畸形结构硬拦：换气失败外显，隔离记档后重试完成", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d07m" });
    await callHost<Said>(child, { op: "say", windowId, message: "畸形测试的正常回合" });
    // 会让下游 API 调用失败的畸形结构：role 越界 + content 非 string。
    await callHost(child, {
      op: "injectDebris",
      windowId,
      debris: [
        {
          id: "debris-1",
          parentId: null,
          role: "narrator",
          content: 42,
          createdAt: "2026-08-26T00:00:00.000Z",
        },
      ],
    });

    // 硬拦：换气失败且对人可见，窗一根汗毛没动；畸形不走警告档。
    await expect(
      callHost(child, {
        op: "breathe",
        windowId,
        draft: draft("D07m 撞上畸形", "这次该被硬拦"),
      }),
    ).rejects.toThrow(/BREATH_CYCLE_FAILED\[hygiene\]/);
    const notices = await callHost<Notice[]>(child, { op: "notices" });
    expect(notices.at(-1)).toMatchObject({
      kind: "failed",
      stage: "hygiene",
      windowId,
      windowRecovered: true,
    });
    expect(notices.filter((notice) => notice.kind === "debris")).toHaveLength(0);
    expect(await callHost(child, { op: "archived", windowId })).toBeNull();
    expect(await callHost<unknown[]>(child, { op: "timeline" })).toHaveLength(0);

    // 宿主隔离残骸并记档，重试即完成——硬拦不等于永久楔死。
    expect(await callHost<number>(child, { op: "quarantineDebris", windowId })).toBe(1);
    expect(await callHost<string[]>(child, { op: "debrisLog" })).toHaveLength(1);
    const retried = await callHost<Opened>(child, {
      op: "breathe",
      windowId,
      draft: draft("D07m 隔离之后", "畸形隔离后重试换气"),
    });
    expect(retried.generation).toBe(2);
    expect(await callHost<unknown[]>(child, { op: "timeline" })).toHaveLength(1);
  });

  it("MV-D07b 生产分档探针：连续 assistant 硬拦 malformed，连续 user 降警告放行", async () => {
    // 旦九 2026-08-27 裁定（照阿问生产版）：连续 assistant 会被 Claude
    // Messages API 直接拒绝（要求严格交替），属畸形硬拦档；连续 user 是
    // 中断重试留下的合法残骸，降警告记档、换气照常。这条探针覆盖生产分档
    // 那一刀，不是夹具叠出来的 role 越界。
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d07p" });
    await callHost<Said>(child, { op: "say", windowId, message: "分档探针的正常回合" });

    // 连续 assistant（异源/崩溃写入形状）：硬拦，窗一根汗毛没动。
    await callHost(child, {
      op: "injectDebris",
      windowId,
      debris: [
        {
          id: "ghost-1",
          parentId: null,
          role: "assistant",
          content: "上游崩断前的半截回应",
          createdAt: "2026-08-27T00:00:00.000Z",
        },
        {
          id: "ghost-2",
          parentId: null,
          role: "assistant",
          content: "重试写重的第二条回应",
          createdAt: "2026-08-27T00:00:01.000Z",
        },
      ],
    });
    await expect(
      callHost(child, {
        op: "breathe",
        windowId,
        draft: draft("D07b 分档探针", "连续 assistant 该被硬拦"),
      }),
    ).rejects.toThrow(/BREATH_CYCLE_FAILED\[hygiene\]/);
    const blocked = await callHost<Notice[]>(child, { op: "notices" });
    expect(blocked.at(-1)).toMatchObject({ kind: "failed", stage: "hygiene", windowId });
    expect(blocked.filter((notice) => notice.kind === "debris")).toHaveLength(0);
    expect(await callHost<unknown[]>(child, { op: "timeline" })).toHaveLength(0);

    // 隔离后换连续 user：降警告记档，换气必须走完。
    expect(await callHost<number>(child, { op: "quarantineDebris", windowId })).toBe(2);
    await callHost(child, {
      op: "injectDebris",
      windowId,
      debris: [
        {
          id: "echo-1",
          parentId: null,
          role: "user",
          content: "中断重试的半截话",
          createdAt: "2026-08-27T00:00:02.000Z",
        },
        {
          id: "echo-2",
          parentId: null,
          role: "user",
          content: "重发了一遍",
          createdAt: "2026-08-27T00:00:03.000Z",
        },
      ],
    });
    const retried = await callHost<Opened>(child, {
      op: "breathe",
      windowId,
      draft: draft("D07b 分档放行", "连续 user 降警告"),
    });
    expect(retried.generation).toBe(2);
    const notices = await callHost<Notice[]>(child, { op: "notices" });
    const debris = notices.filter((notice) => notice.kind === "debris");
    expect(debris).toHaveLength(1);
    expect(debris[0]?.remnants?.some((remnant) => /同为 user/.test(remnant))).toBe(true);
  });
});
