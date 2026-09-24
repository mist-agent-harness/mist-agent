/**
 * #120（WH-01～WH-05）的**生产验收驱动**。
 *
 * acceptance/window-history-run.ts import 本文件并调用 createWindowHistoryDriver()：
 * 缺本文件时六盏灯全红（判卷先行的起点），本文件到位后 WH-01～WH-05 用**真实证据**转绿，
 * WH-06 早在 FEAT-002 就凭静态审计真绿。
 *
 * 真实性纪律（清单 [集成] 要求）：
 *   - startHost() 真 spawn 一个子进程（src/window-host/window-history-host-process.ts），
 *     镜像 tests/fixtures/one-stream-host.ts 的 spawn + stdio ipc + {requestId,ok,value}
 *     把手；返回真实 {pid, bootId, dataDir}，bootId/pid 每次 boot 都不同。
 *   - 每个方法都转发给正在跑的子进程，返回子进程的 Result 原样（结构化可克隆，判卷会用
 *     cloneWindowHistoryDriverBoundary 的 structuredClone 过一遍边界）。
 *   - 同一个 driver 实例分配一个稳定的临时 dataDir，跨 kill/restart 复用（绝对路径、真实
 *     非零字节），reset() 才 rm -rf 重建——所以 killHost 丢光内存态、startHost 只能从盘上
 *     读回来，WH-01 的耐久断言不是内存替身蒙过去的。
 *   - 故障注入是**真实落盘篡改**（见 src/window-host/window-host-faults.ts）：读屏障标记
 *     文件、翻 payload 字节、删格式记录；不是 mock 返回值。
 *
 * 非 root 依赖（明写）：整套 window-history 验收须以**非 root**跑（misttest 闸）。本驱动的
 * 读失败注入用「屏障标记文件 + 读路径显式检查」实现，本身不依赖运行身份；但仓里另有约十处
 * chmod-based 写失败测试在 root 下会假红，故 `npm run acceptance:window-history:strict` 必须
 * 走 `sudo -u misttest` 的闸（见 docs/runtime-config.md 与任务闸配方）。
 *
 * STUBBED：空。WindowHistoryDriver 的每个方法都真实经过子进程 + 真实落盘实现，无桩。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppendReceipt,
  AppendWindowEventInput,
  DurableSnapshot,
  HostDescriptor,
  MigrationOutcome,
  MigrationState,
  Result,
  Tombstone,
  WindowDescriptor,
  WindowHistoryDriver,
  WindowHistoryPage,
  WindowHistoryPageRequest,
  WindowHistoryRef,
  WindowHistorySummary,
  WriterIdentity,
} from "../acceptance/window-history-driver.ts";

/** 无桩：所有方法都真实实现。判卷据此不把任何灯当桩灯（黄灯）。 */
export const STUBBED: readonly string[] = [];

const HOST_PROCESS = fileURLToPath(
  new URL("./window-host/window-history-host-process.ts", import.meta.url),
);
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface HostReply {
  readonly requestId?: string;
  readonly type?: string;
  readonly pid?: number;
  readonly bootId?: string;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name?: string; readonly message?: string };
}

let requestSequence = 0;

class WindowHistoryProductionDriver implements WindowHistoryDriver {
  readonly #dataDir: string;
  #child: ChildProcess | null = null;
  #descriptor: HostDescriptor | null = null;

  constructor() {
    // 稳定的每实例落盘根：跨 kill/restart 复用，reset() 才清掉重建。
    this.#dataDir = mkdtempSync(join(tmpdir(), "mist-window-history-"));
  }

  // —— 真实宿主：起得来、杀得死、拉得起 ——

  async startHost(): Promise<HostDescriptor> {
    if (this.#child !== null) await this.killHost();
    const child = spawn(process.execPath, ["--import", "tsx", HOST_PROCESS], {
      env: { ...process.env, MIST_WINDOW_HISTORY_DIR: this.#dataDir },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.#child = child;
    const descriptor = await waitForReady(child, this.#dataDir);
    this.#descriptor = descriptor;
    return descriptor;
  }

  async killHost(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }

  async hostDescriptor(): Promise<HostDescriptor> {
    if (this.#descriptor === null) throw new Error("host has not been started");
    return this.#descriptor;
  }

  async reset(): Promise<void> {
    await this.killHost();
    this.#descriptor = null;
    // rm -rf 落盘目录 + 全部注入的故障，再重建干净目录（dataDir 路径不变）。
    rmSync(this.#dataDir, { recursive: true, force: true });
  }

  // —— 底座写入侧 ——

  openWindow(input: { residentId: string; windowId: string }): Promise<Result<WindowDescriptor>> {
    return this.#call("openWindow", { input });
  }

  appendWindowEvent(input: AppendWindowEventInput): Promise<Result<AppendReceipt>> {
    return this.#call("appendWindowEvent", { input });
  }

  appendWindowEventsConcurrently(
    inputs: readonly AppendWindowEventInput[],
  ): Promise<ReadonlyArray<Result<AppendReceipt>>> {
    return this.#call("appendWindowEventsConcurrently", { inputs });
  }

  rotateGeneration(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    return this.#call("rotateGeneration", { input });
  }

  archiveWindow(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    return this.#call("archiveWindow", { input });
  }

  async writerIdentity(): Promise<Result<WriterIdentity>> {
    // 契约返回 Result<...>，所以「宿主未起 / 写句柄已交还」是 fail-closed 结构化值，
    // 不是抛异常：中断迁移后宿主真死了，唯一写方不可用（"writer-unavailable"），
    // 判卷据此确认中断确实发生，而不是被一记 throw 掀成「抛错」。
    if (this.#child === null) {
      return {
        ok: false,
        error: {
          code: "writer-unavailable",
          message: "window-history host is not running; writer is unavailable",
          windowId: null,
        },
      };
    }
    return this.#call("writerIdentity", {});
  }

  // —— 判卷对象：只读投影 ——

  summarize(ref: WindowHistoryRef): Promise<Result<WindowHistorySummary>> {
    return this.#call("summarize", { ref });
  }

  read(ref: WindowHistoryRef, page: WindowHistoryPageRequest): Promise<Result<WindowHistoryPage>> {
    return this.#call("read", { ref, page });
  }

  // —— 故障注入 ——

  async injectStorageReadFailure(input: {
    residentId: string;
    windowId: string;
  }): Promise<void> {
    await this.#call("injectStorageReadFailure", { input });
  }

  async clearStorageReadFailure(): Promise<void> {
    await this.#call("clearStorageReadFailure", {});
  }

  async deleteDurableWindowData(input: {
    residentId: string;
    windowId: string;
  }): Promise<void> {
    await this.#call("deleteDurableWindowData", { input });
  }

  async corruptDurableEntry(input: {
    residentId: string;
    windowId: string;
    streamSeq: number;
  }): Promise<void> {
    await this.#call("corruptDurableEntry", { input });
  }

  // —— 迁移与回滚 ——

  durableSnapshot(): Promise<DurableSnapshot> {
    return this.#call("durableSnapshot", {});
  }

  migrationState(): Promise<MigrationState> {
    return this.#call("migrationState", {});
  }

  migrateStorageFormat(input: {
    targetFormatVersion: number;
  }): Promise<Result<MigrationOutcome>> {
    return this.#call("migrateStorageFormat", { input });
  }

  rollbackStorageFormat(input: {
    targetFormatVersion: number;
  }): Promise<Result<MigrationOutcome>> {
    return this.#call("rollbackStorageFormat", { input });
  }

  async interruptMigration(input: {
    targetFormatVersion: number;
    fault: "host-killed" | "disk-full";
  }): Promise<void> {
    const child = this.#requireChild();
    // 子进程会落下 incomplete 态、发回执、然后 SIGKILL 自己；这里等回执 + 进程退出。
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await this.#call("interruptMigration", { input });
    await exited;
    // 宿主返回时已经死了：清掉本地句柄，迫使后续 startHost 只能从盘上读回来。
    this.#child = null;
  }

  resumeMigration(): Promise<Result<MigrationOutcome>> {
    return this.#call("resumeMigration", {});
  }

  readTombstones(): Promise<Result<readonly Tombstone[]>> {
    return this.#call("readTombstones", {});
  }

  // —— IPC ——

  #requireChild(): ChildProcess {
    const child = this.#child;
    if (child === null) throw new Error("host is not running; call startHost() first");
    return child;
  }

  #call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const child = this.#requireChild();
    requestSequence += 1;
    const requestId = `wh-request-${requestSequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => cleanup(new Error(`window-history host request timed out: ${op} (${requestId})`)),
        REQUEST_TIMEOUT_MS,
      );
      const onMessage = (message: HostReply): void => {
        if (message.requestId !== requestId) return;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (message.ok === true) resolve(message.value as T);
        else reject(new Error(message.error?.message ?? `host op failed: ${op}`));
      };
      const onExit = (): void => {
        cleanup(new Error(`window-history host exited before answering ${op}`));
      };
      function cleanup(error: Error): void {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        reject(error);
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ op, requestId, ...payload }, (error) => {
        if (error === null) return;
        cleanup(error);
      });
    });
  }
}

function waitForReady(child: ChildProcess, dataDir: string): Promise<HostDescriptor> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => cleanup(new Error(`window-history host startup timed out: ${stderr}`)),
      READY_TIMEOUT_MS,
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const onMessage = (message: HostReply): void => {
      if (message.type !== "ready") return;
      if (typeof message.pid !== "number" || typeof message.bootId !== "string") return;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      resolve({ pid: message.pid, bootId: message.bootId, dataDir });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup(
        new Error(
          `window-history host exited ${String(code)}/${String(signal)} before ready: ${stderr}`,
        ),
      );
    };
    function cleanup(error: Error): void {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      reject(error);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

export function createWindowHistoryDriver(): WindowHistoryDriver {
  return new WindowHistoryProductionDriver();
}
