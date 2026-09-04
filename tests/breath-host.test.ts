import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryNode } from "../acceptance/driver.ts";
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

type Receipt = { residentId: string; windowId: string; generation: number; dispatchId: string };
type Live = {
  residentId: string;
  windowId: string;
  scopeId: string;
  generation: number;
  headId: string | null;
} | null;
type Letter = { title: string; windowId: string; residentId: string; generation: number };
type Ctx = { notes: string[]; letter?: Letter };

/**
 * MV-D10 换气不改窗身份（real host subprocess）。
 *
 * 这一组走的是图纸 §4.1 的**换气**（BreathCycle.breathe：信落定 → 同一 windowId
 * 换代），不是泳道 1 的 kill + 带 windowId 重开——tests/handover-letter.test.ts
 * 那组只钉了「同 id 重开身份不变」这个更弱的性质，并明说 D10 要在真换气上重打。
 *
 * 判红样例两条都要被钉住：换气流程中重新签发 windowId；换气后旧 windowId 查不到该窗。
 */
describe("MV-D10 换气不改窗身份（real host subprocess）", () => {
  it("windowId 逐字不变，只 generation + 1；旧 windowId 换气后仍解析到同一扇活窗", async () => {
    const child = startHost();
    await waitForReady(child);
    const opened = await callHost<Opened>(child, { op: "open", residentId: "resident-d10" });
    expect(opened.generation).toBe(1);

    await callHost<Said>(child, { op: "say", windowId: opened.windowId, message: "换气前的一句" });
    const before = await callHost<Live>(child, { op: "live", windowId: opened.windowId });
    expect(before).not.toBeNull();

    const breathed = await callHost<Opened>(child, {
      op: "breathe",
      windowId: opened.windowId,
      draft: draft("D10 第一次换气", "身份不变只换代"),
    });
    // 逐字相等：不是「等价」，是同一串字节。
    expect(breathed.windowId).toBe(opened.windowId);
    expect(breathed.generation).toBe(opened.generation + 1);

    // 旧 windowId 仍解析到活窗（判红样例二：换气后旧 windowId 查不到该窗）。
    const after = await callHost<Live>(child, { op: "live", windowId: opened.windowId });
    expect(after).not.toBeNull();
    expect(after?.windowId).toBe(opened.windowId);
    expect(after?.residentId).toBe(before?.residentId);
    expect(after?.scopeId).toBe(before?.scopeId);
    expect(after?.generation).toBe(2);
    // 换气不是归档：同一 id 在归档簿里查不到「一扇死窗」。
    const archived = await callHost<unknown>(child, { op: "archived", windowId: opened.windowId });
    expect(archived).toBeNull();
  });

  it("换气前的派发回执换气后仍解析到同一扇窗：旧代回执按 generation 判旧，不是悬空", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d10b" });

    const stale = await callHost<Receipt>(child, { op: "issueDispatch", windowId });
    expect(stale).toMatchObject({ residentId: "resident-d10b", windowId, generation: 1 });
    expect(await callHost<boolean>(child, { op: "belongsToActiveWindow", receipt: stale })).toBe(
      true,
    );

    await callHost<Opened>(child, {
      op: "breathe",
      windowId,
      draft: draft("D10 回执跨代", "回执按代际判旧"),
    });

    // 回执里的 windowId 换气后照样查得到窗——引用没有悬空。
    const resolved = await callHost<Live>(child, { op: "live", windowId: stale.windowId });
    expect(resolved?.windowId).toBe(windowId);
    expect(resolved?.generation).toBe(2);
    // 旧代回执被判旧（generation 不匹配），而不是「窗不存在」；新代回执立即有效。
    expect(await callHost<boolean>(child, { op: "belongsToActiveWindow", receipt: stale })).toBe(
      false,
    );
    const fresh = await callHost<Receipt>(child, { op: "issueDispatch", windowId });
    expect(fresh.windowId).toBe(stale.windowId);
    expect(fresh.generation).toBe(2);
    expect(await callHost<boolean>(child, { op: "belongsToActiveWindow", receipt: fresh })).toBe(
      true,
    );
  });

  it("时间线锚点与外部绑定跨代仍指向同一扇窗；连续三次换气 id 不动、代际单调", async () => {
    const child = startHost();
    await waitForReady(child);
    const { windowId } = await callHost<Opened>(child, { op: "open", residentId: "resident-d10c" });
    // 外部绑定：调用方拿到 windowId 当句柄，换气前配了阈值、开过回合。
    await callHost(child, { op: "configureThreshold", windowId, tokens: 10_000 });
    await callHost<Said>(child, { op: "say", windowId, message: "第一代的话" });

    let generation = 1;
    for (const title of ["D10 换气一", "D10 换气二", "D10 换气三"]) {
      const breathed = await callHost<Opened>(child, {
        op: "breathe",
        windowId,
        draft: draft(title, `第 ${generation} 代封缄`),
      });
      expect(breathed.windowId).toBe(windowId);
      expect(breathed.generation).toBe(generation + 1);
      generation = breathed.generation;

      // 换气后阈值重新可配（新代尚无回合过闸），仍用同一个 windowId 句柄（MV-D02 的换代口径）。
      await callHost(child, { op: "configureThreshold", windowId, tokens: 10_000 });
      // 同一个句柄，换气后不重新 open、不重新登记，照常开工（外部绑定不悬空）。
      const said = await callHost<Said>(child, {
        op: "say",
        windowId,
        message: `第 ${generation} 代的话`,
      });
      expect(said.node.role).toBe("assistant");
    }
    expect(generation).toBe(4);

    // 时间线锚点：每封信钉着同一 windowId 与写信那一代；新代 context 里的信指回同一扇窗。
    const timeline = await callHost<Letter[]>(child, { op: "timeline" });
    expect(timeline.map((letter) => letter.windowId)).toEqual([windowId, windowId, windowId]);
    expect(timeline.map((letter) => letter.generation)).toEqual([1, 2, 3]);
    expect(timeline.map((letter) => letter.title)).toEqual([
      "D10 换气一",
      "D10 换气二",
      "D10 换气三",
    ]);
    const context = await callHost<Ctx>(child, { op: "context", windowId });
    expect(context.letter?.windowId).toBe(windowId);
    expect(context.letter?.generation).toBe(3);

    // 全程只有一扇窗：归档簿里查不到它，活窗簿里它是第 4 代。
    expect(await callHost<unknown>(child, { op: "archived", windowId })).toBeNull();
    expect((await callHost<Live>(child, { op: "live", windowId }))?.generation).toBe(4);
  });
});
