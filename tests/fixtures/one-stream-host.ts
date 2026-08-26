import {
  type CanonicalEventDraft,
  CanonicalStreamProjection,
  CanonicalStreamStore,
  CanonicalStreamWriter,
  type WriterCheckpointName,
} from "../../src/one-stream/index.ts";

const dataDir = process.env.MIST_ONE_STREAM_DIR;
if (dataDir === undefined) throw new Error("MIST_ONE_STREAM_DIR is required");

const haltAt = process.env.MIST_ONE_STREAM_HALT_AT as WriterCheckpointName | undefined;
const store = new CanonicalStreamStore({ dataDir });
const projections = new Map<string, CanonicalStreamProjection>();
const writer = new CanonicalStreamWriter(store, {
  checkpoint: async (checkpoint) => {
    await send({ type: "checkpoint", name: checkpoint.name, residentId: checkpoint.residentId });
    if (haltAt === checkpoint.name) {
      process.kill(process.pid, "SIGKILL");
    }
  },
});

type Command = {
  requestId?: string;
  op?: string;
  residentId?: string;
  clientId?: string;
  idempotencyKey?: string;
  draft?: CanonicalEventDraft;
  afterSeq?: number;
};

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("IPC channel is unavailable"));
      return;
    }
    process.send(message, (error) => {
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
  switch (command.op) {
    case "create": {
      const residentId = required(command.residentId, "residentId");
      store.createStream(residentId);
      return { residentId };
    }
    case "submit":
      if (command.draft === undefined) throw new Error("draft is required");
      return writer.submit({
        residentId: required(command.residentId, "residentId"),
        idempotencyKey: required(command.idempotencyKey, "idempotencyKey"),
        draft: command.draft,
      });
    case "events":
      return store.eventsAfter(required(command.residentId, "residentId"), command.afterSeq ?? 0);
    case "openProjection": {
      const clientId = required(command.clientId, "clientId");
      projections.set(
        clientId,
        new CanonicalStreamProjection(store, required(command.residentId, "residentId")),
      );
      return { clientId };
    }
    case "pullProjection": {
      const clientId = required(command.clientId, "clientId");
      const projection = projections.get(clientId);
      if (projection === undefined) throw new Error(`unknown projection: ${clientId}`);
      return projection.pull();
    }
    case "projectionSnapshot": {
      const clientId = required(command.clientId, "clientId");
      const projection = projections.get(clientId);
      if (projection === undefined) throw new Error(`unknown projection: ${clientId}`);
      return projection.snapshot();
    }
    case "stop":
      await writer.close();
      return "stopping";
    default:
      throw new Error(`unknown op: ${String(command.op)}`);
  }
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
        error: {
          name: failure.name,
          message: failure.message,
          code: "code" in failure ? Reflect.get(failure, "code") : undefined,
        },
      });
    }
  })();
});

await send({ type: "ready", pid: process.pid });
