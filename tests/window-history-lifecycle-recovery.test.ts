/**
 * #120 独立验收席（2026-09-24）钉的缺陷一：**窗生命周期状态重启后不可恢复**。
 *
 * 三个子缺陷，本文件逐个钉死（每条负向断言都配正向对照，避免空断言点绿）：
 *   1a 换气不耐久 —— 重启后旧代迟到写被接受（WH-02 的 fail-closed 只在单进程内成立）；
 *   1b 归档窗仍可写 —— D7（docs/decisions.md:74）定「关窗归档为只读日志」；
 *   1c 归档窗重启后 running 报 true —— 归档态根本没落盘。
 *
 * 施工后的口径：窗的代际与归档态是**耐久事实**，全部经先决①的唯一写方
 * （CanonicalStreamWriter）落进 canonical stream，冷启动只靠重放这些事实重建窗账。
 * 因此本文件同时钉三条「不许顺手打破」的边界：
 *   · 窗账事实的 viewport 为空 => 绝不进 window-history 只读投影的条目集合
 *     （WH-03 逐项比较旧引用事件集合，多一条就判红）；
 *   · 开了但没写过的窗仍必须 summarize.blank === true；
 *   · 交接信同样用 purpose:"lifecycle"，所以识别窗账事实不许按 purpose 一刀切。
 *
 * 跨进程证据用真实子进程 + 真实目录 + 真实 SIGKILL（tests/fixtures/
 * window-history-lifecycle-crash.ts）；同进程重启证据用「close 旧宿主 + 同 dataDir 起
 * 新宿主」（写句柄按 dataDir 作用域独占，close 后才能再起一个）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WindowHistoryPageRequest, WindowHistoryRef } from "../src/window-history/index.ts";
import { WindowHistoryHost } from "../src/window-host/index.ts";

const FULL_PAGE: WindowHistoryPageRequest = { beforeSeq: null, maxMessages: null };
const CRASH_FIXTURE = fileURLToPath(
  new URL("./fixtures/window-history-lifecycle-crash.ts", import.meta.url),
);

let root: string;
let dataDir: string;
const openHosts: WindowHistoryHost[] = [];

/** 每个宿主实例一套独立 eventId 前缀：重启后复用前缀会与落盘事件撞 id。 */
function makeHost(prefix: string): WindowHistoryHost {
  let seed = 0;
  const host = new WindowHistoryHost({
    dataDir,
    writerId: "test-writer",
    newEventId: () => {
      seed += 1;
      return `${prefix}-${seed}`;
    },
  });
  openHosts.push(host);
  return host;
}

/** 模拟重启：交还写句柄，再在同一 dataDir 上起一个全新宿主（内存态全丢）。 */
async function restart(host: WindowHistoryHost, prefix: string): Promise<WindowHistoryHost> {
  await host.close();
  return makeHost(prefix);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wh-lifecycle-"));
  dataDir = join(root, "data");
});

afterEach(async () => {
  for (const host of openHosts.splice(0)) await host.close();
  rmSync(root, { recursive: true, force: true });
});

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function marksOf(page: { entries: readonly { payload: { readonly [key: string]: unknown } }[] }) {
  return page.entries.map((entry) => entry.payload.mark);
}

interface CrashReport {
  readonly [key: string]: string | number | boolean;
}

/** 真实子进程跑一遍生命周期动作后 SIGKILL 自己；返回它自报的同进程观察结果。 */
function runCrashFixture(reportPath: string): Promise<{
  readonly signal: NodeJS.Signals | null;
  readonly report: CrashReport;
}> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", CRASH_FIXTURE, dataDir, reportPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== "SIGKILL") {
        reject(
          new Error(
            `fixture did not hard-kill itself (${String(code)}/${String(signal)}): ${stderr}`,
          ),
        );
        return;
      }
      resolve({ signal, report: JSON.parse(readFileSync(reportPath, "utf8")) as CrashReport });
    });
  });
}

describe("#120 window lifecycle survives a restart (acceptance seat defect 1)", () => {
  it("1a: a rotate is durable — after a real SIGKILL restart an old-generation write is still stale-generation", async () => {
    const reportPath = join(root, "crash-report.json");
    const crash = await runCrashFixture(reportPath);

    // 正向对照（同进程内）：夹具确实开了窗、写成功、换到第 2 代，且同进程旧代写已被拒。
    expect(crash.signal).toBe("SIGKILL");
    expect(crash.report.openWin1).toBe(true);
    expect(crash.report.gen1Write).toBe(true);
    expect(crash.report.rotatedTo).toBe(2);
    expect(crash.report.lateWriteSameProcess).toBe("stale-generation");

    // 新进程（本测试进程）在同一目录上拉起宿主：换气必须仍然成立。
    const restarted = makeHost("after-crash");
    const late = await restarted.appendWindowEvent({
      residentId: "res-a",
      windowId: "win-1",
      generation: 1,
      idempotencyKey: "win-1-late-after-restart",
      payload: { mark: "late-after-restart" },
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("stale-generation");

    const ref: WindowHistoryRef = { residentId: "res-a", windowId: "win-1", generation: null };
    const page = unwrap(await restarted.read(ref, FULL_PAGE));
    expect(marksOf(page)).toEqual(["hi"]);

    // 正向对照：重启后当代（第 2 代）写照常成功，不是「一律拒绝」蒙过去的。
    const current = await restarted.appendWindowEvent({
      residentId: "res-a",
      windowId: "win-1",
      generation: 2,
      idempotencyKey: "win-1-gen2",
      payload: { mark: "gen2" },
    });
    expect(current.ok).toBe(true);
    expect(marksOf(unwrap(await restarted.read(ref, FULL_PAGE)))).toEqual(["hi", "gen2"]);
  });

  it("1a: a rotate is durable across an in-process restart on the same dataDir", async () => {
    const host = makeHost("boot1");
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "w" }));
    unwrap(
      await host.appendWindowEvent({
        residentId: "res-a",
        windowId: "w",
        generation: 1,
        idempotencyKey: "gen1",
        payload: { mark: "gen1" },
      }),
    );
    expect(
      unwrap(await host.rotateGeneration({ residentId: "res-a", windowId: "w" })).generation,
    ).toBe(2);

    const restarted = await restart(host, "boot2");
    const stale = await restarted.appendWindowEvent({
      residentId: "res-a",
      windowId: "w",
      generation: 1,
      idempotencyKey: "late",
      payload: { mark: "late" },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale-generation");

    // 换气水位也不许「多退一代」：重启后 openWindow 报的仍是第 2 代，不是第 1 代。
    const reopened = unwrap(await restarted.openWindow({ residentId: "res-a", windowId: "w" }));
    expect(reopened.generation).toBe(2);
    expect(reopened.archived).toBe(false);
  });

  it("1b: an archived window rejects a same-generation write (D7: archived window is a read-only log)", async () => {
    const host = makeHost("boot1");
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "w" }));
    // 正向对照：归档前同代写成功。
    unwrap(
      await host.appendWindowEvent({
        residentId: "res-a",
        windowId: "w",
        generation: 1,
        idempotencyKey: "before-archive",
        payload: { mark: "before-archive" },
      }),
    );

    expect(unwrap(await host.archiveWindow({ residentId: "res-a", windowId: "w" })).archived).toBe(
      true,
    );
    const afterArchive = await host.appendWindowEvent({
      residentId: "res-a",
      windowId: "w",
      generation: 1,
      idempotencyKey: "after-archive",
      payload: { mark: "after-archive" },
    });
    expect(afterArchive.ok).toBe(false);
    if (!afterArchive.ok) {
      expect(afterArchive.error.code).toBe("stale-generation");
      expect(afterArchive.error.message).toContain("archived");
      expect(afterArchive.error.windowId).toBe("w");
    }

    // 被拒的写在投影侧如实缺席；归档窗本身仍可读（WH-03 要求）。
    const ref: WindowHistoryRef = { residentId: "res-a", windowId: "w", generation: null };
    expect(marksOf(unwrap(await host.read(ref, FULL_PAGE)))).toEqual(["before-archive"]);

    // 正向对照：换气（按同一身份重开）后新代可写，旧代仍只读。
    expect(
      unwrap(await host.rotateGeneration({ residentId: "res-a", windowId: "w" })).generation,
    ).toBe(2);
    expect(
      (
        await host.appendWindowEvent({
          residentId: "res-a",
          windowId: "w",
          generation: 2,
          idempotencyKey: "gen2",
          payload: { mark: "gen2" },
        })
      ).ok,
    ).toBe(true);
  });

  it("1b: the archive stays read-only after a restart", async () => {
    const host = makeHost("boot1");
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "w" }));
    unwrap(
      await host.appendWindowEvent({
        residentId: "res-a",
        windowId: "w",
        generation: 1,
        idempotencyKey: "one",
        payload: { mark: "one" },
      }),
    );
    unwrap(await host.archiveWindow({ residentId: "res-a", windowId: "w" }));

    const restarted = await restart(host, "boot2");
    const write = await restarted.appendWindowEvent({
      residentId: "res-a",
      windowId: "w",
      generation: 1,
      idempotencyKey: "after-restart",
      payload: { mark: "after-restart" },
    });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe("stale-generation");
    const ref: WindowHistoryRef = { residentId: "res-a", windowId: "w", generation: null };
    expect(marksOf(unwrap(await restarted.read(ref, FULL_PAGE)))).toEqual(["one"]);
  });

  it("1c: an archived window still reports running:false after a restart", async () => {
    const host = makeHost("boot1");
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "archived-window" }));
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "live-window" }));
    unwrap(
      await host.appendWindowEvent({
        residentId: "res-a",
        windowId: "live-window",
        generation: 1,
        idempotencyKey: "live",
        payload: { mark: "live" },
      }),
    );
    unwrap(await host.archiveWindow({ residentId: "res-a", windowId: "archived-window" }));

    const before = unwrap(
      await host.summarize({ residentId: "res-a", windowId: "archived-window", generation: null }),
    );
    expect(before.running).toBe(false);

    const restarted = await restart(host, "boot2");
    const after = unwrap(
      await restarted.summarize({
        residentId: "res-a",
        windowId: "archived-window",
        generation: null,
      }),
    );
    expect(after.running).toBe(false);
    // 正向对照：没归档的窗重启后仍报 running:true（不是「一律 false」蒙过去的）。
    const live = unwrap(
      await restarted.summarize({ residentId: "res-a", windowId: "live-window", generation: null }),
    );
    expect(live.running).toBe(true);
  });

  it("keeps durable lifecycle facts out of the history projection (WH-03 event set, blank, payload)", async () => {
    const host = makeHost("boot1");
    // 开了但一条历史都没写的窗：仍必须 blank，且读回 OK 空页（不是 window-not-found）。
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "empty" }));
    const emptyRef: WindowHistoryRef = { residentId: "res-a", windowId: "empty", generation: null };
    expect(unwrap(await host.read(emptyRef, FULL_PAGE)).entries).toHaveLength(0);
    expect(unwrap(await host.summarize(emptyRef)).blank).toBe(true);
    // 换气 + 归档都写了耐久事实之后，空窗依然 blank。
    unwrap(await host.rotateGeneration({ residentId: "res-a", windowId: "empty" }));
    unwrap(await host.archiveWindow({ residentId: "res-a", windowId: "empty" }));
    expect(unwrap(await host.summarize(emptyRef)).blank).toBe(true);
    expect(unwrap(await host.read(emptyRef, FULL_PAGE)).entries).toHaveLength(0);

    // WH-03 口径：换气前按 (windowId, generation) 取到的事件集合，换气/归档后逐项不变。
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "w" }));
    for (const mark of ["g1-0", "g1-1"]) {
      unwrap(
        await host.appendWindowEvent({
          residentId: "res-a",
          windowId: "w",
          generation: 1,
          idempotencyKey: mark,
          payload: { mark },
        }),
      );
    }
    const slice: WindowHistoryRef = { residentId: "res-a", windowId: "w", generation: 1 };
    const beforeRotate = unwrap(await host.read(slice, FULL_PAGE));
    expect(beforeRotate.entries).toHaveLength(2);
    unwrap(await host.rotateGeneration({ residentId: "res-a", windowId: "w" }));
    unwrap(await host.archiveWindow({ residentId: "res-a", windowId: "w" }));
    const afterRotate = unwrap(await host.read(slice, FULL_PAGE));
    expect(afterRotate.entries.map((entry) => entry.eventId)).toEqual(
      beforeRotate.entries.map((entry) => entry.eventId),
    );
    expect(marksOf(afterRotate)).toEqual(["g1-0", "g1-1"]);

    // 整窗读也只有历史条目，没有窗账事实混进来。
    const whole = unwrap(
      await host.read({ residentId: "res-a", windowId: "w", generation: null }, FULL_PAGE),
    );
    expect(whole.entries).toHaveLength(2);
    expect(whole.damaged).toHaveLength(0);
    for (const entry of whole.entries) {
      expect(entry.payload.kind).toBeUndefined();
      expect(entry.payload.state).toBeUndefined();
    }
  });

  it("existence authority: losing a window's format record fail-closes reads without destroying the substrate", async () => {
    const host = makeHost("boot1");
    unwrap(await host.openWindow({ residentId: "res-a", windowId: "w" }));
    unwrap(
      await host.appendWindowEvent({
        residentId: "res-a",
        windowId: "w",
        generation: 1,
        idempotencyKey: "one",
        payload: { mark: "one" },
      }),
    );
    unwrap(await host.rotateGeneration({ residentId: "res-a", windowId: "w" }));

    // 抹掉这扇窗的落盘格式记录（WH-04 的 deleteDurableWindowData）：读必须 fail-closed，
    // 不许拿空页冒充「这窗没有历史」。
    host.deleteDurableWindowData({ residentId: "res-a", windowId: "w" });
    const ref: WindowHistoryRef = { residentId: "res-a", windowId: "w", generation: null };
    const missing = await host.read(ref, FULL_PAGE);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("window-not-found");

    // 底座（唯一底座、append-only）没被删过，所以重新登记这扇窗时它的耐久生命周期
    // 事实必须原样回来：代际仍是第 2 代，绝不倒退回第 1 代让旧代迟到写复活。
    const reopened = unwrap(await host.openWindow({ residentId: "res-a", windowId: "w" }));
    expect(reopened.generation).toBe(2);
    const stale = await host.appendWindowEvent({
      residentId: "res-a",
      windowId: "w",
      generation: 1,
      idempotencyKey: "late",
      payload: { mark: "late" },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale-generation");
    expect(marksOf(unwrap(await host.read(ref, FULL_PAGE)))).toEqual(["one"]);
  });
});
