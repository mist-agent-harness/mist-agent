/**
 * MV-B03 集成宿主：真实 MistDriver → MessageTreeService → responder，父进程
 * 通过 IPC 在 responder 在途时杀窗，验证派发、回执、丢弃三类日志。
 */

import { createDriver } from "../../src/acceptance-driver.ts";
import type { DispatchEvent } from "../../src/message-tree/index.ts";

const events: DispatchEvent[] = [];
let holdNextReply = false;
let releaseHeldReply: ((value: string) => void) | null = null;

const driver = createDriver({
  dispatchEventLogger: {
    log: (event) => events.push(event),
  },
  reply: (_residentId, message) => {
    if (!holdNextReply) return `回应：${message}`;
    holdNextReply = false;
    return new Promise<string>((resolve) => {
      releaseHeldReply = resolve;
    });
  },
});

type HostCommand = {
  requestId: string;
  op:
    | "createResident"
    | "holdNext"
    | "say"
    | "killSession"
    | "release"
    | "events"
    | "history"
    | "stop";
  residentId?: string;
  name?: string;
  message?: string;
};

function requireString(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`missing ${field}`);
  return value;
}

async function execute(command: HostCommand): Promise<unknown> {
  switch (command.op) {
    case "createResident":
      return driver.createResident(requireString(command.name, "name"));
    case "holdNext":
      if (releaseHeldReply !== null) throw new Error("a reply is already held");
      holdNextReply = true;
      return null;
    case "say":
      return driver.say(
        requireString(command.residentId, "residentId"),
        requireString(command.message, "message"),
      );
    case "killSession":
      await driver.killSession(requireString(command.residentId, "residentId"));
      return null;
    case "release": {
      const release = releaseHeldReply;
      if (release === null) throw new Error("no reply is held");
      releaseHeldReply = null;
      release("迟到回应");
      return null;
    }
    case "events":
      return structuredClone(events);
    case "history":
      return driver.history(requireString(command.residentId, "residentId"));
    case "stop":
      return null;
  }
}

process.on("message", (raw) => {
  const command = raw as HostCommand;
  void (async () => {
    try {
      const value = await execute(command);
      process.send?.({ requestId: command.requestId, ok: true, value });
      if (command.op === "stop") setImmediate(() => process.exit(0));
    } catch (error) {
      process.send?.({
        requestId: command.requestId,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          code:
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : undefined,
        },
      });
    }
  })();
});

process.send?.({ type: "ready", pid: process.pid });
