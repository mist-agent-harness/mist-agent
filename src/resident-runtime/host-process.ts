/**
 * #194 住户运行时的**真实宿主子进程**（RT-02「跨进程重启同一条主流」的证据源）。
 *
 * 形状照 src/window-host/window-history-host-process.ts 与 tests/fixtures/one-stream-host.ts：
 * spawn + stdio ipc + `{requestId, ok, value|error}`。进程读 MIST_RESIDENT_RUNTIME_DIR
 * 构造 ResidentRuntime（唯一 writer 在这个进程里），报 `{type:'ready', pid, bootId}`，
 * bootId 每次启动新随机——判卷靠 pid + bootId 断言「确实换了一个进程」。
 *
 * 被 SIGKILL 后内存态全丢：一窗流、住户档案、凭证、窗账 journal 全在盘上，
 * 重启只能从盘读回——这正是 RT-02 的耐久断言要的真实证据，不是内存替身。
 *
 * 代价：宿主里同步/异步方法统一包成 IPC 请求响应（和 window-history 一样的税）；
 * 换来判卷只经进程边界观察，绝不共享内存态。
 */
import { randomUUID } from "node:crypto";
import type {
  BootPackView,
  BreathTrigger,
  BreatheOutcome,
  ChannelSpec,
  LetterTimeline,
  Result,
  SecretScanReport,
  StreamFileInventory,
  StreamSnapshot,
  TurnResult,
} from "../../acceptance/resident-runtime-driver.ts";
import type { ChannelSpecLike } from "./channels.ts";
import { ResidentRuntime } from "./runtime.ts";

const dataDir = process.env.MIST_RESIDENT_RUNTIME_DIR;
if (dataDir === undefined || dataDir.length === 0) {
  throw new Error("MIST_RESIDENT_RUNTIME_DIR is required for the resident runtime host process");
}

/** 每次 boot 新随机；判卷靠它 + pid 断言「确实换了一个进程」。 */
const bootId = randomUUID();
const runtime = new ResidentRuntime({ dataDir });

interface Command {
  readonly requestId?: string;
  readonly op?: string;
  readonly input?: {
    readonly residentId?: string;
    readonly text?: string;
    /** 重试锚：同回合重试带同一 turnId，幂等键由它派生（见 runtime.say）。 */
    readonly turnId?: string;
    readonly channel?: ChannelSpecLike;
    readonly canarySecret?: string;
    readonly needle?: string;
    readonly generation?: number;
    /** 换气面（RT-03）：窗身份、触发线、入口。 */
    readonly windowId?: string;
    readonly thresholdTokens?: number;
    readonly authority?: "window" | "owner";
    readonly via?: "new" | "clear" | "compact";
  };
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

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function handle(command: Command): Promise<unknown> {
  const input = command.input ?? {};
  switch (command.op) {
    case "resolveChannelRoute":
      return runtime.resolveChannelRoute({
        channel: requiredChannel(input.channel),
      }) as Result<unknown>;
    case "provisionChannel":
      return runtime.provisionChannel({
        residentId: required(input.residentId, "residentId"),
        channel: requiredChannel(input.channel),
        canarySecret: required(input.canarySecret, "canarySecret"),
      }) as Result<unknown>;
    case "revokeCredential":
      runtime.revokeCredential({ residentId: required(input.residentId, "residentId") });
      return null;
    case "say":
      return (await runtime.say({
        residentId: required(input.residentId, "residentId"),
        text: required(input.text, "text"),
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      })) as Result<TurnResult>;
    case "readStream":
      return runtime.readStream({
        residentId: required(input.residentId, "residentId"),
      }) as Result<StreamSnapshot>;
    case "streamFiles":
      return runtime.streamFiles() as Result<StreamFileInventory>;
    case "bootPack":
      return runtime.bootPack({
        residentId: required(input.residentId, "residentId"),
      }) as Result<BootPackView>;
    case "letterTimeline":
      return runtime.letterTimeline({
        residentId: required(input.residentId, "residentId"),
      }) as Result<LetterTimeline>;
    case "setBreathThreshold":
      return runtime.setBreathThreshold({
        residentId: required(input.residentId, "residentId"),
        windowId: required(input.windowId, "windowId"),
        generation: input.generation ?? 0,
        thresholdTokens: input.thresholdTokens ?? 0,
        authority: input.authority ?? "window",
      }) as Result<void>;
    case "breathe":
      return (await runtime.breathe({
        residentId: required(input.residentId, "residentId"),
        via: input.via ?? "new",
      })) as Result<BreatheOutcome>;
    case "suddenDeath":
      await runtime.suddenDeath({ residentId: required(input.residentId, "residentId") });
      return null;
    case "archivedTranscript":
      return runtime.archivedTranscript({
        residentId: required(input.residentId, "residentId"),
        generation: input.generation ?? 0,
      }) as Result<StreamSnapshot>;
    case "secretScan":
      return runtime.secretScan({
        residentId: required(input.residentId, "residentId"),
        needle: required(input.needle, "needle"),
      }) as Result<SecretScanReport>;
    case "stop":
      await runtime.close();
      return "stopping";
    default:
      throw new Error(`unknown op: ${String(command.op)}`);
  }
}

function requiredChannel(channel: ChannelSpecLike | undefined): ChannelSpecLike {
  if (channel === undefined) throw new Error("channel is required");
  // 结构校验交给 resolveChannelRoute 的规格检查；这里只保证形状到位。
  const spec: ChannelSpec = {
    claudeSubscription: channel.claudeSubscription,
    credentialKind: channel.credentialKind,
    model: channel.model,
  };
  return spec;
}

process.on("message", (message: Command) => {
  void (async () => {
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
