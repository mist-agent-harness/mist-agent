/**
 * D31-1 前端验收的**真实宿主夹具进程**：内部跑现役
 * `assembleResidentRuntime({ dataDir, transport: 受控合成 })`，经普通 IPC 暴露
 * say/requireActiveResident/readStream/bootPack/breathe 等现有能力，外加仅测试用的
 * `enqueueReply`（受控 transport 的下一条回复）与 `readModelRequests`（真实收到的
 * `ModelCompletionRequest` 记录）。
 *
 * 这不是模拟 host：它真的构造 `ResidentRuntime`、用其唯一 writer、走 `say()` 的
 * 现役交付/回执序列。生产 host/CLI 不夹 fixture 队列或默认回复。
 */
import { randomUUID } from "node:crypto";
import type {
  BootPackView,
  BreatheOutcome,
  ChannelSpec,
  Result,
  StreamFileInventory,
  StreamSnapshot,
  TurnResult,
} from "../../acceptance/resident-runtime-driver.ts";
import { assembleResidentRuntime } from "../../src/resident-runtime/assembly.ts";
import type {
  ModelCompletionRequest,
  ModelTransport,
} from "../../src/resident-runtime/channels.ts";

const dataDir = process.env.MIST_FRONTEND_HOST_DIR;
if (dataDir === undefined || dataDir.length === 0) {
  throw new Error("MIST_FRONTEND_HOST_DIR is required for the frontend text host fixture");
}

/** 受控合成 transport：按住户排队回复，如实记录每个 ModelCompletionRequest。 */
class ControlledTransport implements ModelTransport {
  readonly #queues = new Map<string, string[]>();
  readonly requests: ModelCompletionRequest[] = [];
  enqueue(residentId: string, text: string): void {
    const queue = this.#queues.get(residentId) ?? [];
    queue.push(text);
    this.#queues.set(residentId, queue);
  }
  async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
    this.requests.push(request);
    const queue = this.#queues.get(request.residentId);
    const reply = queue?.shift();
    if (reply === undefined) {
      throw new Error("controlled transport has no queued reply for this resident");
    }
    yield reply;
  }
}

const transport = new ControlledTransport();
const runtime = assembleResidentRuntime({ dataDir, transport });

interface Command {
  readonly requestId?: string;
  readonly op?: string;
  readonly input?: Record<string, unknown>;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function handle(command: Command): Promise<unknown> {
  const input = command.input ?? {};
  switch (command.op) {
    case "createCandidate":
      return runtime.createCandidate({
        persona: requiredString(input.persona, "persona"),
        proposedBy: input.proposedBy as never,
        ...(typeof input.residentId === "string" ? { residentId: input.residentId } : {}),
      });
    case "attestCandidate":
      return runtime.attestCandidate(
        requiredString(input.candidateId, "candidateId"),
        input.actor as never,
        input.decision as never,
      );
    case "requireActiveResident":
      return runtime.requireActiveResident(requiredString(input.referenceId, "referenceId"));
    case "provisionChannel":
      return runtime.provisionChannel({
        residentId: requiredString(input.residentId, "residentId"),
        channel: input.channel as ChannelSpec,
        canarySecret: requiredString(input.canarySecret, "canarySecret"),
      }) as Result<unknown>;
    case "say":
      return (await runtime.say({
        residentId: requiredString(input.residentId, "residentId"),
        text: requiredString(input.text, "text"),
      })) as Result<TurnResult>;
    case "readStream":
      return runtime.readStream({
        residentId: requiredString(input.residentId, "residentId"),
      }) as Result<StreamSnapshot>;
    case "streamFiles":
      return runtime.streamFiles() as Result<StreamFileInventory>;
    case "bootPack":
      return runtime.bootPack({
        residentId: requiredString(input.residentId, "residentId"),
      }) as Result<BootPackView>;
    case "breathe":
      return (await runtime.breathe({
        residentId: requiredString(input.residentId, "residentId"),
        via: input.via === "clear" || input.via === "compact" ? input.via : "new",
      })) as Result<BreatheOutcome>;
    case "enqueueReply":
      transport.enqueue(
        requiredString(input.residentId, "residentId"),
        requiredString(input.text, "text"),
      );
      return null;
    case "readModelRequests":
      return transport.requests.map((request) => ({
        residentId: request.residentId,
        adapterId: request.adapterId,
        model: request.model,
        text: request.text,
        history: request.history.map((item) => ({ role: item.role, text: item.text })),
        bootPack: {
          residentId: request.bootPack.residentId,
          identity: request.bootPack.identity,
          commitments: [...request.bootPack.commitments],
        },
        credentialSecretPresent: request.credentialSecret.length > 0,
      }));
    case "stop":
      await runtime.close();
      return "stopping";
    default:
      throw new Error(`unknown op: ${String(command.op)}`);
  }
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("IPC channel is unavailable"));
      return;
    }
    process.send(message, (error: Error | null) => (error === null ? resolve() : reject(error)));
  });
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

await send({ type: "ready", pid: process.pid, bootId: randomUUID() });
