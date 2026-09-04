import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BootPack, HistoryNode, MemoryEntry } from "../acceptance/driver.ts";
import type { TurnGateEvent } from "../src/session/turn-gate.ts";
import type { GapProbe, LedgerEntry } from "../src/store/fact-ledger.ts";

/**
 * 开工闸集成测试（验收清单 MV-A05、MV-C01/C02/C03/C05/C07 的 [集成] 半格）：
 * 真实宿主子进程，杀得起拉得起。进程内装配全是生产件（MistDriver / FactLedger /
 * SessionRegistry / MessageTreeService / ViewportTurnGate），故障注入只裹在
 * probeGap 与 commit 外面——注入的是「通道失败」，不是改账。
 *
 * 测试数据全为虚构占位（AGENTS.md：住户内容不进仓库）。
 */

type HostReply = {
  requestId?: string;
  type?: string;
  pid?: number;
  ok?: boolean;
  value?: unknown;
  error?: { name?: string; message?: string };
};

type SayResult = { node: HistoryNode; prompt: string | null };

const children: ChildProcess[] = [];
const directories: string[] = [];
const fixture = fileURLToPath(new URL("./fixtures/turn-gate-host.ts", import.meta.url));

function startHost(dataDir?: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: {
      ...process.env,
      ...(dataDir === undefined ? {} : { MIST_TURN_GATE_DATADIR: dataDir }),
    },
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
        reject(new Error(`${message.error?.name}: ${message.error?.message}`));
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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 从闸事件日志里取 driver 窗的 windowId——driver 窗由生产懒开窗路径开出，日志三元组是它的出生证。 */
async function driverWindowId(child: ChildProcess): Promise<string> {
  const events = await callHost<TurnGateEvent[]>(child, { op: "logEvents" });
  const event = events.find((e) => e.event === "gate_clear" || e.event === "gate_gap_pulled");
  if (event === undefined) throw new Error("driver 窗还没有任何闸事件");
  return event.windowId;
}

describe("turn-gate real host subprocess", () => {
  it("MV-A05 新窗不背全史：baseline=50，缺口为零，启动包带现行有效集", async () => {
    const child = startHost();
    await waitForReady(child);
    const { residentId } = await callHost<{ residentId: string }>(child, {
      op: "createResident",
      name: "placeholder-a05",
    });
    for (let i = 1; i <= 50; i += 1) {
      await callHost(child, {
        op: "appendRuling",
        residentId,
        author: "main-thread",
        kind: "ruling",
        body: `placeholder ruling ${i}`,
      });
    }

    // 启动包先走：开首窗（baseline=50 + 冻结快照），currentFacts 携带开窗
    // 截面的现行有效集——包即交付，不是全史拉取。
    const pack = await callHost<BootPack>(child, { op: "bootpack", residentId });
    expect(pack.currentFacts).toHaveLength(50);
    expect(pack.currentFacts?.every((entry) => entry.kind === "ruling")).toBe(true);

    // 快照已被包消费：首轮 say 零注入（不背全史），模型拿到的就是原话。
    const said = await callHost<SayResult>(child, {
      op: "sayOn",
      residentId,
      message: "placeholder first turn",
    });
    expect(said.prompt).toBe("placeholder first turn");

    const windowId = await driverWindowId(child);
    expect(await callHost<number>(child, { op: "ackedSeq", residentId, windowId })).toBe(50);
    expect(await callHost<GapProbe>(child, { op: "probe", residentId, windowId })).toEqual({
      status: "ok",
      latestSeq: 50,
      ackedSeq: 50,
    });

    // 第二轮 say 同样只有原话——初始对齐只交付一次。
    const secondSay = await callHost<SayResult>(child, {
      op: "sayOn",
      residentId,
      message: "placeholder second turn",
    });
    expect(secondSay.prompt).toBe("placeholder second turn");

    // 已交付的窗再要启动包：显式拒绝（要重建请先 killSession）。
    await expect(callHost(child, { op: "bootpack", residentId })).rejects.toThrow(
      /BootPackAlignmentError/,
    );
  });

  it("MV-C01/C02 横向可见：主线程落账后，B 窗下一轮经拉取看到裁定并追平（拉是唯一正确性来源）", async () => {
    const child = startHost();
    await waitForReady(child);
    const { residentId } = await callHost<{ residentId: string }>(child, {
      op: "createResident",
      name: "placeholder-c01",
    });
    // A 窗先开工（driver 懒开窗路径）。MV-C02 的正确性来源只有拉：
    // 本实现不存在推送通道（无可模拟、无可丢弃），B 窗能看到的每一条裁定
    // 都只能是开工闸拉来的。
    await callHost(child, { op: "sayOn", residentId, message: "placeholder A turn" });
    const { windowId: windowB, baseline } = await callHost<{ windowId: string; baseline: number }>(
      child,
      { op: "openWindowB", residentId },
    );
    expect(baseline).toBe(0);

    await callHost(child, {
      op: "appendRuling",
      residentId,
      author: "main-thread",
      kind: "ruling",
      body: "placeholder cross-window ruling",
    });

    const saidB = await callHost<SayResult>(child, {
      op: "sayOnB",
      residentId,
      message: "placeholder B turn",
    });
    expect(saidB.prompt).toContain(
      "[权威事实账缺口 | kind=ruling | seq=1 | author=main-thread] placeholder cross-window ruling",
    );
    // B 窗的 user 节点仍只落原话。
    expect(saidB.node.role).toBe("assistant");
    expect(await callHost<number>(child, { op: "ackedSeq", residentId, windowId: windowB })).toBe(
      1,
    );
  });

  it("MV-C03 查账失败按缺处理：say fail-closed，history 放行且日志记「缺口未知」", async () => {
    const child = startHost();
    await waitForReady(child);
    const { residentId } = await callHost<{ residentId: string }>(child, {
      op: "createResident",
      name: "placeholder-c03",
    });
    await callHost(child, { op: "sayOn", residentId, message: "placeholder before failure" });
    await callHost(child, { op: "failProbe", on: true });

    await expect(
      callHost(child, { op: "sayOn", residentId, message: "placeholder rejected turn" }),
    ).rejects.toThrow(/GateUnavailableError/);

    // 普通动作放行：history 正常返回（此时树里只有第一轮的两个节点）。
    const history = await callHost<HistoryNode[]>(child, { op: "history", residentId });
    expect(history).toHaveLength(2);

    const events = await callHost<TurnGateEvent[]>(child, { op: "logEvents" });
    const unknownEvents = events.filter((e) => e.event === "gate_unknown");
    // say 被拒一次 + history 报到一次，两条都得记「缺口未知」。
    expect(unknownEvents.length).toBeGreaterThanOrEqual(2);
    expect(unknownEvents.every((e) => e.detail.includes("缺口未知"))).toBe(true);
    // generation 预期是 number 且为 1：两条事件都落在 driver 自己注册的那扇
    // 一代窗上（不是 registry 查不到的窗——那种才该落 null）。
    expect(unknownEvents.every((e) => e.generation === 1)).toBe(true);

    // 注入撤销后闸恢复放行——fail-closed 不是永久熔断。
    await callHost(child, { op: "failProbe", on: false });
    const recovered = await callHost<SayResult>(child, {
      op: "sayOn",
      residentId,
      message: "placeholder recovered turn",
    });
    expect(recovered.node.role).toBe("assistant");
  });

  it("MV-C05 回执丢失归传播机制：窗不被记为已知悉，下轮重拉后正常 ack", async () => {
    const child = startHost();
    await waitForReady(child);
    const { residentId } = await callHost<{ residentId: string }>(child, {
      op: "createResident",
      name: "placeholder-c05",
    });
    const { windowId: windowB } = await callHost<{ windowId: string }>(child, {
      op: "openWindowB",
      residentId,
    });
    await callHost(child, {
      op: "appendRuling",
      residentId,
      author: "main-thread",
      kind: "ruling",
      body: "placeholder ack-loss ruling",
    });

    // 遮掉 commit（回执丢失）：这轮照常开工、照常注入，但账不记已知悉——
    // 账上不存在「失约」标记，无回执 = 尚未知悉，就这么一个形状。
    await callHost(child, { op: "dropCommit", on: true });
    const firstTry = await callHost<SayResult>(child, {
      op: "sayOnB",
      residentId,
      message: "placeholder lost-ack turn",
    });
    expect(firstTry.prompt).toContain("placeholder ack-loss ruling");
    expect(await callHost<number>(child, { op: "ackedSeq", residentId, windowId: windowB })).toBe(
      0,
    );

    const eventsAfterLoss = await callHost<TurnGateEvent[]>(child, { op: "logEvents" });
    expect(eventsAfterLoss.some((e) => e.event === "gate_gap_pulled")).toBe(true);
    expect(eventsAfterLoss.some((e) => e.event === "gate_ack")).toBe(false);

    // 下一轮重拉同一份缺口，这次回执到账。
    await callHost(child, { op: "dropCommit", on: false });
    const secondTry = await callHost<SayResult>(child, {
      op: "sayOnB",
      residentId,
      message: "placeholder redelivered turn",
    });
    expect(secondTry.prompt).toContain("placeholder ack-loss ruling");
    expect(await callHost<number>(child, { op: "ackedSeq", residentId, windowId: windowB })).toBe(
      1,
    );
    const eventsFinal = await callHost<TurnGateEvent[]>(child, { op: "logEvents" });
    expect(eventsFinal.filter((e) => e.event === "gate_gap_pulled")).toHaveLength(2);
    expect(eventsFinal.filter((e) => e.event === "gate_ack")).toHaveLength(1);
  });

  it("MV-C07 supersede 是追加不是涂改：旧条目字节不变，解除经缺口通道可见，现行集剔除旧条目", async () => {
    const child = startHost();
    await waitForReady(child);
    const { residentId } = await callHost<{ residentId: string }>(child, {
      op: "createResident",
      name: "placeholder-c07",
    });
    await callHost(child, {
      op: "appendRuling",
      residentId,
      author: "main-thread",
      kind: "ruling",
      body: "placeholder ruling to be superseded",
    });
    // A 窗先 ack 掉这条 ruling。
    await callHost(child, { op: "sayOn", residentId, message: "placeholder ack turn" });
    const windowId = await driverWindowId(child);
    expect(await callHost<number>(child, { op: "ackedSeq", residentId, windowId })).toBe(1);

    const beforeEntries = await callHost<LedgerEntry[]>(child, { op: "entries", residentId });
    const original = beforeEntries.find((entry) => entry.seq === 1);
    expect(original).toBeDefined();

    const supersedeEntry = await callHost<LedgerEntry>(child, {
      op: "supersede",
      residentId,
      targetSeq: 1,
      author: "main-thread",
      reason: "placeholder supersede reason",
    });
    expect(supersedeEntry).toMatchObject({ seq: 2, kind: "supersede", supersedesSeq: 1 });

    // 旧条目字节不变；新解除是一条自带序号的追加账。
    const afterEntries = await callHost<LedgerEntry[]>(child, { op: "entries", residentId });
    expect(afterEntries).toHaveLength(2);
    expect(afterEntries.find((entry) => entry.seq === 1)).toEqual(original);

    // 已 ack 旧条目的窗，下一轮经缺口通道看到这条 supersede——注入里必须
    // 带被解除条目的 seq 指针，模型才知道解除的是哪一条（F2）。
    const said = await callHost<SayResult>(child, {
      op: "sayOn",
      residentId,
      message: "placeholder post-supersede turn",
    });
    expect(said.prompt).toContain(
      "[权威事实账缺口 | kind=supersede | seq=2 | supersedes=seq 1 | author=main-thread] placeholder supersede reason",
    );
    expect(await callHost<number>(child, { op: "ackedSeq", residentId, windowId })).toBe(2);

    // 现行有效集不再含旧条目（直接查账侧推导视图；此窗初始对齐已交付，
    // 启动包只对未对齐的窗生成——MV-A05 已钉包通道）。
    expect(await callHost<LedgerEntry[]>(child, { op: "currentSet", residentId })).toEqual([]);
  });

  it("MV-C04 闸在非缺失方：落后窗直写裁定级条目被账侧拒收，账上一个字节不多；追平后放行", async () => {
    const child = startHost();
    await waitForReady(child);
    const { residentId } = await callHost<{ residentId: string }>(child, {
      op: "createResident",
      name: "placeholder-c04",
    });
    // B 窗开在空账上（baseline=0），随后主线程落一条裁定——B 落后一条，
    // 且这条路径上没有任何窗自查：拦不拦全看账侧写路径。
    const { windowId: windowB } = await callHost<{ windowId: string }>(child, {
      op: "openWindowB",
      residentId,
    });
    await callHost(child, {
      op: "appendRuling",
      residentId,
      author: "main-thread",
      kind: "ruling",
      body: "placeholder ruling unseen by B",
    });

    // 落后窗写新裁定：拒收，且账上没有多出条目。
    await expect(
      callHost(child, {
        op: "appendRulingFromB",
        residentId,
        author: "placeholder-resident",
        kind: "ruling",
        body: "placeholder stale write",
      }),
    ).rejects.toThrow(/StaleViewportError/);
    // 落后窗解除它没见过的那条裁定：同样拒收。
    await expect(
      callHost(child, {
        op: "supersedeFromB",
        residentId,
        targetSeq: 1,
        author: "placeholder-resident",
        reason: "placeholder stale supersede",
      }),
    ).rejects.toThrow(/StaleViewportError/);
    expect(await callHost<LedgerEntry[]>(child, { op: "entries", residentId })).toHaveLength(1);

    // B 过一轮开工闸追平缺口后，同一扇窗的写入放行——闸拦的是「落后」，
    // 不是「窗」。
    await callHost(child, { op: "sayOnB", residentId, message: "placeholder align turn" });
    expect(await callHost<number>(child, { op: "ackedSeq", residentId, windowId: windowB })).toBe(
      1,
    );
    const written = await callHost<LedgerEntry>(child, {
      op: "appendRulingFromB",
      residentId,
      author: "placeholder-resident",
      kind: "ruling",
      body: "placeholder synced write",
    });
    expect(written).toMatchObject({ seq: 2, kind: "ruling" });
  });

  it("MV-C04 unknown 半格：查账失败时窗署名写入 fail-closed；非窗来源写入不受此闸", async () => {
    const child = startHost();
    await waitForReady(child);
    const { residentId } = await callHost<{ residentId: string }>(child, {
      op: "createResident",
      name: "placeholder-c04-unknown",
    });
    await callHost(child, { op: "openWindowB", residentId });
    await callHost(child, { op: "failProbe", on: true });

    // 查不到 ≠ 没缺口：窗署名的裁定级写入 fail-closed。
    await expect(
      callHost(child, {
        op: "appendRulingFromB",
        residentId,
        author: "placeholder-resident",
        kind: "ruling",
        body: "placeholder write under unknown",
      }),
    ).rejects.toThrow(/WriteGateUnavailableError/);
    expect(await callHost<LedgerEntry[]>(child, { op: "entries", residentId })).toHaveLength(0);

    // 非窗来源（主线程落账）不经 C04 闸——闸拦的是「落后的窗」，
    // 不是「不是窗的写方」。
    const mainWrite = await callHost<LedgerEntry>(child, {
      op: "appendRuling",
      residentId,
      author: "main-thread",
      kind: "ruling",
      body: "placeholder main-thread write during outage",
    });
    expect(mainWrite).toMatchObject({ seq: 1, kind: "ruling" });

    // 注入撤销后，追平的窗恢复写入——fail-closed 不是永久熔断。
    await callHost(child, { op: "failProbe", on: false });
    await callHost(child, { op: "sayOnB", residentId, message: "placeholder recovery turn" });
    const recovered = await callHost<LedgerEntry>(child, {
      op: "appendRulingFromB",
      residentId,
      author: "placeholder-resident",
      kind: "ruling",
      body: "placeholder recovered write",
    });
    expect(recovered).toMatchObject({ seq: 2, kind: "ruling" });
  });

  it("宿主猝死不续接旧窗（PR #98 拍板）：同 dataDir 拉起新宿主，人与账原样恢复，新窗重新初始对齐", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-gate-crash-"));
    directories.push(dir);

    // 宿主 A：落盘形态（ResidentStore 与 FactLedger 同目录）。R1 首窗前落账
    // （首轮初始对齐交付并 ack）、R2 第二轮缺口交付并 ack、R1 随后被解除。
    const hostA = startHost(dir);
    await waitForReady(hostA);
    const { residentId } = await callHost<{ residentId: string }>(hostA, {
      op: "createResident",
      name: "placeholder-crash",
    });
    await callHost(hostA, { op: "remember", residentId, content: "placeholder memory" });
    await callHost(hostA, { op: "commit", residentId, commitment: "placeholder commitment" });
    await callHost(hostA, {
      op: "appendRuling",
      residentId,
      author: "main-thread",
      kind: "ruling",
      body: "placeholder ruling one",
    });
    await callHost(hostA, { op: "sayOn", residentId, message: "placeholder A first turn" });
    await callHost(hostA, {
      op: "appendRuling",
      residentId,
      author: "main-thread",
      kind: "ruling",
      body: "placeholder ruling two",
    });
    await callHost(hostA, { op: "sayOn", residentId, message: "placeholder A second turn" });
    await callHost(hostA, {
      op: "supersede",
      residentId,
      targetSeq: 1,
      author: "main-thread",
      reason: "placeholder crash supersede",
    });
    const oldWindowId = await driverWindowId(hostA);
    const entriesBefore = await callHost<LedgerEntry[]>(hostA, { op: "entries", residentId });
    const ackedBefore = await callHost<number>(hostA, {
      op: "ackedSeq",
      residentId,
      windowId: oldWindowId,
    });

    // 猝死：SIGKILL，不给优雅退出——上面每条 IPC 应答都对应一次同步落盘，
    // 最后一个应答回来时盘就是新的。
    hostA.kill("SIGKILL");
    await new Promise<void>((resolve) => hostA.once("exit", () => resolve()));

    const hostB = startHost(dir);
    await waitForReady(hostB);

    // 1. 住户侧原样恢复：记忆与承诺在案（commitments 经 killSession 后的
    //    启动包断言，见下）；history 可用——消息树不随 dataDir 恢复是既有
    //    M0 裁定（tests/acceptance-driver-options.test.ts 钉着「不伪装恢复」），
    //    猝死收窄的是窗，不是这条裁定。
    const recalled = await callHost<MemoryEntry[]>(hostB, {
      op: "recall",
      residentId,
      query: "placeholder",
    });
    expect(recalled.map((entry) => entry.content)).toContain("placeholder memory");
    expect(await callHost<HistoryNode[]>(hostB, { op: "history", residentId })).toEqual([]);

    // 2. 账原样恢复：全史、旧窗确认位、现行集逐项一致。
    expect(await callHost<LedgerEntry[]>(hostB, { op: "entries", residentId })).toEqual(
      entriesBefore,
    );
    expect(
      await callHost<number>(hostB, { op: "ackedSeq", residentId, windowId: oldWindowId }),
    ).toBe(ackedBefore);
    expect(
      (await callHost<LedgerEntry[]>(hostB, { op: "currentSet", residentId })).map((e) => e.body),
    ).toEqual(["placeholder ruling two"]);

    // 3+4. B 首次 say 开出新 windowId（旧窗不续接：B 的 registry 是纯内存，
    // 旧窗从来不是它的活窗；恢复出的旧窗确认位是历史轨迹，无 pending）。
    // 新窗的快照在 B 开窗截面新冻：只含 B 启动时的现行集（R2），A 死前被
    // 解除的 R1 与那条 supersede 都不在注入里（它们在 baseline 之前）。
    const first = await callHost<SayResult>(hostB, {
      op: "sayOn",
      residentId,
      message: "placeholder B first turn",
    });
    const newWindowId = await driverWindowId(hostB);
    expect(newWindowId).not.toBe(oldWindowId);
    expect(first.prompt).toContain(
      "[权威事实账·现行有效集（初始对齐）| kind=ruling | seq=2 | author=main-thread] placeholder ruling two",
    );
    expect(first.prompt).not.toContain("placeholder ruling one");
    expect(first.prompt).not.toContain("[权威事实账缺口");

    // 恰好一次：第二轮零注入。
    const second = await callHost<SayResult>(hostB, {
      op: "sayOn",
      residentId,
      message: "placeholder B second turn",
    });
    expect(second.prompt).toBe("placeholder B second turn");

    // 承诺在案 + 包通道在新窗上可用：killSession 后新窗重新冻结快照出包。
    await callHost(hostB, { op: "killSession", residentId });
    const pack = await callHost<BootPack>(hostB, { op: "bootpack", residentId });
    expect(pack.commitments).toEqual(["placeholder commitment"]);
    expect(pack.currentFacts?.map((entry) => entry.body)).toEqual(["placeholder ruling two"]);
  });
});
