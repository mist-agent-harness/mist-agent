import { IntentionalIsolation } from "../../src/isolation/intentional-isolation.ts";
import { MessageTreeService } from "../../src/message-tree/service.ts";
import { MessageTreeStore } from "../../src/message-tree/store.ts";
import { type DispatchReceipt, SessionRegistry } from "../../src/session/session-registry.ts";
import { ResidentStore } from "../../src/store/resident-store.ts";

const residents = new ResidentStore();
const residentId = residents.createResident("host-resident");
const sessions = new SessionRegistry<null>();
const origin = sessions.open(residentId, { scopeId: "private", context: null });
const tree = new MessageTreeStore();
tree.createRoom(residentId);
const prompts: string[] = [];
const events: import("../../src/message-tree/service.ts").DispatchEvent[] = [];
let releaseReply: ((reply: string) => void) | undefined;
let hold = false;
const isolation = new IntentionalIsolation(residents, sessions);
let isolatedWindowId: string | undefined;
const messages = new MessageTreeService(tree, sessions, {
  turnGate: isolation,
  dispatch: sessions,
  dispatchEventLogger: { log: (event) => events.push(event) },
  assistantReply: (_residentId, prompt) => {
    prompts.push(prompt);
    if (!hold) return "host reply";
    hold = false;
    return new Promise<string>((resolve) => {
      releaseReply = resolve;
    });
  },
});

type Command = {
  requestId: string;
  op:
    | "create"
    | "sharedState"
    | "say"
    | "sayIsolated"
    | "history"
    | "prompts"
    | "stop"
    | "hold"
    | "release"
    | "events"
    | "retire"
    | "activate"
    | "open"
    | "kill"
    | "scopes"
    | "belongs"
    | "consume"
    | "revoke";
  name?: string;
  message?: string;
  windowId?: string;
  scopeId?: string;
  scopeGeneration?: number;
  receipt?: DispatchReceipt;
};

async function execute(command: Command): Promise<unknown> {
  switch (command.op) {
    case "hold":
      hold = true;
      return null;
    case "release": {
      if (!releaseReply) throw new Error("no held reply");
      releaseReply("old result");
      releaseReply = undefined;
      return null;
    }
    case "belongs":
    case "consume":
    case "revoke": {
      if (command.receipt === undefined) throw new Error("receipt required");
      if (command.op === "belongs") return sessions.belongsToActiveWindow(command.receipt);
      if (command.op === "consume") return sessions.consumeDispatch(command.receipt);
      return sessions.revokeDispatch(command.receipt);
    }
    case "events":
      return structuredClone(events);
    case "scopes":
      return sessions.activeScopesOf(residentId);
    case "retire":
      return sessions.retireScope(residentId, command.scopeId ?? "", command.scopeGeneration ?? 0);
    case "activate":
      return sessions.activateScope(residentId, command.scopeId ?? "");
    case "open":
      return sessions.open(residentId, {
        context: null,
        scopeId: command.scopeId ?? "",
        ...(command.windowId ? { windowId: command.windowId } : {}),
      });
    case "kill":
      return sessions.kill(command.windowId ?? "");
    case "create": {
      const created = isolation.create(origin.windowId, {
        name: command.name ?? "",
        context: null,
      });
      isolatedWindowId = created.entryWindowId;
      return created;
    }
    case "sharedState":
      return isolation.sharedState(residentId);
    case "say":
      return messages.say(residentId, command.message ?? "", command.windowId ?? origin.windowId);
    case "sayIsolated":
      if (isolatedWindowId === undefined) throw new Error("isolation session has not been created");
      return messages.say(residentId, command.message ?? "", isolatedWindowId);
    case "history":
      return tree.history(residentId);
    case "prompts":
      return [...prompts];
    case "stop":
      return null;
  }
}

process.on("message", async (raw) => {
  const command = raw as Command;
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
});

process.send?.({
  type: "ready",
  pid: process.pid,
  residentId,
  originWindowId: origin.windowId,
});
