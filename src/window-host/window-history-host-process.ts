/**
 * #120 window-history 生产宿主的**真实子进程夹具**（WH-01～WH-05 的 [集成] 证据源）。
 *
 * 归属：本文件在 src/window-host/（组装/宿主根），不在被 WH-06 审计的投影目录里。
 *
 * 它就是判卷驱动（src/window-history-acceptance-driver.ts）spawn 起来的那个子进程：
 * 在子进程里读 MIST_WINDOW_HISTORY_DIR，构造 FEAT-002 的 WindowHistoryHost（唯一写方
 * + 底座 store + SessionRegistry + 只读投影 + 存储格式管理 + 真实落盘故障注入），报
 * `{type:'ready', pid, bootId}`（bootId 每次启动新随机），然后按 requestId 收发 IPC 把
 * 每个驱动方法转成宿主调用。所有窗事件写入都经唯一写方真实落盘（非零字节）；进程被
 * SIGKILL 后全部内存态丢光，重启只能从盘上读回来——这正是 WH-01 要的真实耐久证据。
 *
 * IPC 幂等：镜像 tests/fixtures/one-stream-host.ts 的请求/响应把手
 * （spawn + stdio ipc + {requestId, ok, value|error}）。interruptMigration 在落下可识别
 * 的 incomplete 态之后 process.kill(process.pid,'SIGKILL') 自杀，模拟「迁移跑到一半宿主
 * 被杀」。
 *
 * 代价（明写）：宿主的只读投影/写入/存储管理/故障注入方法多为同步，这里统一包成 IPC
 * 的异步请求/响应；换来的是判卷只经进程边界观察，绝不共享内存态。
 */
import { randomUUID } from "node:crypto";
import type { WindowHistoryPageRequest, WindowHistoryRef } from "../window-history/index.ts";
import type { AppendWindowEventInput } from "./types.ts";
import { WindowHistoryHost } from "./window-history-host.ts";

const dataDir = process.env.MIST_WINDOW_HISTORY_DIR;
if (dataDir === undefined || dataDir.length === 0) {
  throw new Error("MIST_WINDOW_HISTORY_DIR is required for the window-history host process");
}

/** 每次 boot 新随机；判卷靠它 + pid 断言「确实换了一个进程」。 */
const bootId = randomUUID();
const host = new WindowHistoryHost({ dataDir });

interface Command {
  readonly requestId?: string;
  readonly op?: string;
  readonly input?: unknown;
  readonly inputs?: unknown;
  readonly ref?: unknown;
  readonly page?: unknown;
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("IPC channel is unavailable"));
      return;
    }
    process.send(message, (error: Error | null) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function handle(command: Command): Promise<unknown> {
  switch (command.op) {
    // —— 写入侧 ——
    case "openWindow":
      return host.openWindow(command.input as { residentId: string; windowId: string });
    case "appendWindowEvent":
      return host.appendWindowEvent(command.input as AppendWindowEventInput);
    case "appendWindowEventsConcurrently":
      return host.appendWindowEventsConcurrently(
        command.inputs as readonly AppendWindowEventInput[],
      );
    case "rotateGeneration":
      return host.rotateGeneration(command.input as { residentId: string; windowId: string });
    case "archiveWindow":
      return host.archiveWindow(command.input as { residentId: string; windowId: string });
    case "writerIdentity":
      return host.writerIdentity();

    // —— 只读投影：判卷对象 ——
    case "summarize":
      return host.summarize(command.ref as WindowHistoryRef);
    case "read":
      return host.read(command.ref as WindowHistoryRef, command.page as WindowHistoryPageRequest);

    // —— 故障注入（真实落盘）——
    case "injectStorageReadFailure":
      host.injectStorageReadFailure(command.input as { residentId: string; windowId: string });
      return null;
    case "clearStorageReadFailure":
      host.clearStorageReadFailure();
      return null;
    case "deleteDurableWindowData":
      host.deleteDurableWindowData(command.input as { residentId: string; windowId: string });
      return null;
    case "corruptDurableEntry":
      host.corruptDurableEntry(
        command.input as { residentId: string; windowId: string; streamSeq: number },
      );
      return null;

    // —— 迁移与回滚 ——
    case "durableSnapshot":
      return host.durableSnapshot();
    case "migrationState":
      return host.migrationState();
    case "migrateStorageFormat":
      return host.migrateStorageFormat(command.input as { targetFormatVersion: number });
    case "rollbackStorageFormat":
      return host.rollbackStorageFormat(command.input as { targetFormatVersion: number });
    case "resumeMigration":
      return host.resumeMigration();
    case "readTombstones":
      return host.readTombstones();
    case "interruptMigration": {
      const request = command.input as {
        targetFormatVersion: number;
        fault: "host-killed" | "disk-full";
      };
      // 落下可识别的 incomplete 态 + 迁移前备份，然后立刻自杀（模拟迁移跑一半被杀）。
      host.interruptMigration({ targetFormatVersion: request.targetFormatVersion });
      // 先把成功回执发出去，再硬杀自己——判卷 interruptMigration 返回后宿主已死。
      await send({ requestId: command.requestId, ok: true, value: null });
      process.kill(process.pid, "SIGKILL");
      return null;
    }

    case "stop":
      await host.close();
      return "stopping";
    default:
      throw new Error(`unknown op: ${String(command.op)}`);
  }
}

process.on("message", (message: Command) => {
  void (async () => {
    // interruptMigration 自己负责发回执再自杀，这里不再重复回执。
    if (message.op === "interruptMigration") {
      try {
        await handle(message);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        await send({
          requestId: message.requestId,
          ok: false,
          error: { name: failure.name, message: failure.message },
        });
      }
      return;
    }
    try {
      const value = await handle(message);
      await send({ requestId: message.requestId, ok: true, value });
      if (message.op === "stop") process.disconnect?.();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await send({
        requestId: message.requestId,
        ok: false,
        error: { name: failure.name, message: failure.message },
      });
    }
  })();
});

await send({ type: "ready", pid: process.pid, bootId });
