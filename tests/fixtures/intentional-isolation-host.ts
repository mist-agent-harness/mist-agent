import { IntentionalIsolation } from "../../src/isolation/intentional-isolation.ts";
import { MessageTreeService } from "../../src/message-tree/service.ts";
import { MessageTreeStore } from "../../src/message-tree/store.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import { ResidentStore } from "../../src/store/resident-store.ts";

const residents = new ResidentStore();
const residentId = residents.createResident("host-resident");
const sessions = new SessionRegistry<null>();
const origin = sessions.open(residentId, { scopeId: "private", context: null });
const tree = new MessageTreeStore();
tree.createRoom(residentId);
const prompts: string[] = [];
const isolation = new IntentionalIsolation(residents, sessions);
let isolatedWindowId: string | undefined;
const messages = new MessageTreeService(tree, sessions, {
  turnGate: isolation,
  assistantReply: (_residentId, prompt) => {
    prompts.push(prompt);
    return "host reply";
  },
});

type Command = {
  requestId: string;
  op: "create" | "sharedState" | "say" | "sayIsolated" | "history" | "prompts" | "stop";
  name?: string;
  message?: string;
};

async function execute(command: Command): Promise<unknown> {
  switch (command.op) {
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
      return messages.say(residentId, command.message ?? "", origin.windowId);
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
