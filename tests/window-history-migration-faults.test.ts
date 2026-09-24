/**
 * #120 独立验收席（2026-09-24）钉的缺陷二：**迁移/回滚中途失败不可识别**。
 *
 * 旧口径：migrate() 先备份、再跑完整个重写循环、最后才把控制账落成 complete。单份记录的
 * 写确实原子（tmp+rename），但**多份记录的重写不是一次原子操作** —— 死在循环中间就得到
 * 「前几份 v2、后几份 v1，而控制账仍报旧状态」的盘：一次既没完成、也看不出没完成的操作。
 * WH-05 之所以照绿，是因为判卷走的是 interrupt() 那个独立入口，它只备份 + 落 incomplete，
 * 根本不进重写循环。
 *
 * 本文件把洞钉死，故障全部注入**真实** migrate/rollback 路径：
 *   · 重写循环中途失败（钩子抛错）与中途猝死（真实子进程 + 真实 SIGKILL）后，重启必须
 *     报 incomplete 且可续跑/可退回，读端 fail-closed，绝不把混版本盘当正常数据；
 *   · 未完成的**回滚**只能继续从备份还原 —— 走 #rewriteRecords(1) 会把 legacyMark 写成
 *     null，等于销毁要还原的旧信号点，所以用「还原后 legacyMark 必须非空 + 逐字节等价」
 *     把那条错路堵死；
 *   · 有未完成操作时不许再起一次 migrate（否则会拿混版本的盘再备份一次，覆盖唯一素材）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WindowHistoryPageRequest, WindowHistoryRef } from "../src/window-history/index.ts";
import {
  type DurableSnapshot,
  WindowHistoryHost,
  WindowStorageFormatAdmin,
} from "../src/window-host/index.ts";

const FULL_PAGE: WindowHistoryPageRequest = { beforeSeq: null, maxMessages: null };
const CRASH_FIXTURE = fileURLToPath(
  new URL("./fixtures/window-storage-migration-crash.ts", import.meta.url),
);
const RESIDENT = "res-a";
const WINDOWS = ["w-1", "w-2", "w-3"] as const;

let root: string;
let dataDir: string;
const openHosts: WindowHistoryHost[] = [];

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

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** 种三扇窗、每扇一条历史，然后交还写句柄（之后的故障注入只碰存储格式侧）。 */
async function seedThreeWindows(): Promise<void> {
  const host = makeHost("seed");
  for (const windowId of WINDOWS) {
    unwrap(await host.openWindow({ residentId: RESIDENT, windowId }));
    unwrap(
      await host.appendWindowEvent({
        residentId: RESIDENT,
        windowId,
        generation: 1,
        idempotencyKey: `${windowId}-0`,
        payload: { mark: `${windowId}-0` },
      }),
    );
  }
  await host.close();
}

interface FormatRecordOnDisk {
  readonly formatVersion: number;
  readonly windowKey: string;
  readonly legacyMark: string | null;
}

/** 直接从盘上读每扇窗的格式记录：判「是否版本混杂」「legacyMark 是否被销毁」的硬证据。 */
function formatRecordsOnDisk(): FormatRecordOnDisk[] {
  return readdirSync(dataDir)
    .filter((file) => file.endsWith(".wh-format.json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dataDir, file), "utf8")) as FormatRecordOnDisk);
}

function snapshotShape(snapshot: DurableSnapshot): string {
  return JSON.stringify(
    [...snapshot.records]
      .map((record) => ({
        relativePath: record.relativePath,
        byteHash: record.byteHash,
        byteLength: record.byteLength,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  );
}

function backupBytes(): string {
  const backupDir = join(dataDir, "window-history.backup");
  return readdirSync(backupDir)
    .sort()
    .map((file) => `${file}=${readFileSync(join(backupDir, file), "utf8")}`)
    .join("\n");
}

/** 真实子进程跑真实 migrate/rollback，在循环中间 SIGKILL 自己。 */
function runCrashFixture(mode: "mid-migrate" | "mid-rollback"): Promise<NodeJS.Signals | null> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", CRASH_FIXTURE, dataDir, mode],
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
      resolve(signal);
    });
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wh-migration-faults-"));
  dataDir = join(root, "data");
});

afterEach(async () => {
  for (const host of openHosts.splice(0)) await host.close();
  rmSync(root, { recursive: true, force: true });
});

describe("#120 mid-rewrite migration faults are recognizable (acceptance seat defect 2)", () => {
  it("a write failure inside the real rewrite loop leaves a recognizable, repairable incomplete store", async () => {
    await seedThreeWindows();
    const v1Snapshot = snapshotShape(new WindowStorageFormatAdmin(dataDir).durableSnapshot());

    // 真实 migrate 路径：第一份记录落盘后抛错（模拟盘满/写失败）。
    const faulted = new WindowStorageFormatAdmin(dataDir, {
      onRecordPersisted: (progress) => {
        if (progress.persisted === 1) throw new Error("injected disk-full during record rewrite");
      },
    });
    expect(() => faulted.migrate(2)).toThrow(/injected disk-full/);

    // 正对照：故障确实落在循环中间 —— 盘上此刻版本混杂（既有 v2 也有 v1）。
    const mixed = formatRecordsOnDisk();
    expect(mixed.filter((record) => record.formatVersion === 2).length).toBeGreaterThan(0);
    expect(mixed.filter((record) => record.formatVersion === 1).length).toBeGreaterThan(0);

    // 重启（新进程口径：全新 admin/宿主只读盘）：这堆混版本必须**可识别**为未完成。
    const state = new WindowStorageFormatAdmin(dataDir).migrationState();
    expect(state.status).toBe("incomplete");
    expect(state.resumable || state.rollbackAvailable).toBe(true);
    // 声称的版本不许谎报成目标版本。
    expect(state.formatVersion).toBe(1);

    const host = makeHost("after-fault");
    const ref: WindowHistoryRef = { residentId: RESIDENT, windowId: "w-1", generation: null };
    const during = await host.read(ref, FULL_PAGE);
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.error.code).toBe("migration-incomplete");

    // 可修复：续跑到单一版本，历史条目不变。
    expect(unwrap(host.resumeMigration()).formatVersion).toBe(2);
    expect(host.migrationState().status).toBe("complete");
    const repaired = unwrap(await host.read(ref, FULL_PAGE));
    expect(new Set(repaired.entries.map((entry) => entry.formatVersion))).toEqual(new Set([2]));
    expect(repaired.entries.map((entry) => entry.payload.mark)).toEqual(["w-1-0"]);
    for (const record of formatRecordsOnDisk()) expect(record.formatVersion).toBe(2);

    // 另一条修复路径也在：退回 v1 后逐条记录与迁移前字节等价。
    expect(unwrap(host.rollbackStorageFormat({ targetFormatVersion: 1 })).formatVersion).toBe(1);
    expect(snapshotShape(host.durableSnapshot())).toBe(v1Snapshot);
  });

  it("a real SIGKILL inside the real rewrite loop leaves a recognizable, repairable incomplete store", async () => {
    await seedThreeWindows();
    const v1Snapshot = snapshotShape(new WindowStorageFormatAdmin(dataDir).durableSnapshot());

    expect(await runCrashFixture("mid-migrate")).toBe("SIGKILL");

    // 正对照：真的死在循环中间 —— 盘上版本混杂。
    const mixed = formatRecordsOnDisk();
    expect(mixed.filter((record) => record.formatVersion === 2).length).toBeGreaterThan(0);
    expect(mixed.filter((record) => record.formatVersion === 1).length).toBeGreaterThan(0);

    const host = makeHost("after-kill");
    const state = host.migrationState();
    expect(state.status).toBe("incomplete");
    expect(state.resumable || state.rollbackAvailable).toBe(true);
    const ref: WindowHistoryRef = { residentId: RESIDENT, windowId: "w-2", generation: null };
    const during = await host.read(ref, FULL_PAGE);
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.error.code).toBe("migration-incomplete");

    // 这次选「整体退回」修复：逐条记录与迁移前字节等价，读数不变。
    expect(unwrap(host.rollbackStorageFormat({ targetFormatVersion: 1 })).formatVersion).toBe(1);
    expect(host.migrationState().status).toBe("rolled-back");
    expect(snapshotShape(host.durableSnapshot())).toBe(v1Snapshot);
    const page = unwrap(await host.read(ref, FULL_PAGE));
    expect(page.entries.map((entry) => entry.payload.mark)).toEqual(["w-2-0"]);
    for (const record of formatRecordsOnDisk()) {
      expect(record.formatVersion).toBe(1);
      expect(record.legacyMark).toBe(`legacy:${record.windowKey}`);
    }
  });

  it("resuming a half-finished rollback restores from the backup and never rewrites records to v1", async () => {
    await seedThreeWindows();
    const v1Snapshot = snapshotShape(new WindowStorageFormatAdmin(dataDir).durableSnapshot());
    const v1Records = formatRecordsOnDisk();
    // 正对照：迁移前每份记录都带着旧信号点 legacyMark（否则下面「没被销毁」是空断言）。
    for (const record of v1Records) expect(record.legacyMark).toBe(`legacy:${record.windowKey}`);

    // 真实 migrate 完成 + 真实 rollback 死在还原循环中间。
    expect(await runCrashFixture("mid-rollback")).toBe("SIGKILL");
    const mixed = formatRecordsOnDisk();
    expect(mixed.filter((record) => record.formatVersion === 1).length).toBeGreaterThan(0);
    expect(mixed.filter((record) => record.formatVersion === 2).length).toBeGreaterThan(0);

    const host = makeHost("after-rollback-kill");
    expect(host.migrationState().status).toBe("incomplete");
    const ref: WindowHistoryRef = { residentId: RESIDENT, windowId: "w-3", generation: null };
    const during = await host.read(ref, FULL_PAGE);
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.error.code).toBe("migration-incomplete");

    // 续跑必须**继续回滚**（从备份还原），不是把记录重写成 v1：
    // 后者会把 legacyMark 写成 null，逐字节比较与 legacyMark 断言都会抓到。
    const resumed = unwrap(host.resumeMigration());
    expect(resumed.formatVersion).toBe(1);
    expect(host.migrationState().status).toBe("rolled-back");
    expect(host.migrationState().formatVersion).toBe(1);
    for (const record of formatRecordsOnDisk()) {
      expect(record.formatVersion).toBe(1);
      expect(record.legacyMark).toBe(`legacy:${record.windowKey}`);
    }
    expect(snapshotShape(host.durableSnapshot())).toBe(v1Snapshot);
    const page = unwrap(await host.read(ref, FULL_PAGE));
    expect(page.entries.map((entry) => entry.payload.mark)).toEqual(["w-3-0"]);
  });

  it("refuses to start another migration while one is unfinished, leaving the rollback material intact", async () => {
    await seedThreeWindows();
    expect(await runCrashFixture("mid-migrate")).toBe("SIGKILL");
    const backupBefore = backupBytes();
    // 正对照：备份里确实是迁移前的 v1 字节（带 legacyMark），值得保护。
    expect(backupBefore).toContain("legacy:");

    const host = makeHost("after-kill");
    const refused = host.migrateStorageFormat({ targetFormatVersion: 2 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("storage-unavailable");
      expect(refused.error.message).toContain("unfinished");
    }
    // 被拒之后备份字节一个都没动（否则唯一的回滚素材已被混版本数据覆盖）。
    expect(backupBytes()).toBe(backupBefore);
    expect(host.migrationState().status).toBe("incomplete");

    // 正对照：先续跑把状态收干净，之后再迁移就不再被拒。
    expect(unwrap(host.resumeMigration()).formatVersion).toBe(2);
    expect(host.migrateStorageFormat({ targetFormatVersion: 2 }).ok).toBe(true);
  });
});
