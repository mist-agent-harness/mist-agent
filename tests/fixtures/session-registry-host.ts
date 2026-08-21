import { SessionRegistry } from "../../src/session/session-registry.ts";

const archivePath = process.env.MIST_WINDOW_ARCHIVE_PATH;
const sessions = new SessionRegistry<null>(archivePath === undefined ? {} : { archivePath });

type HostCommand = {
  requestId: string;
  op:
    | "open"
    | "get"
    | "getArchived"
    | "setHead"
    | "issueDispatch"
    | "belongs"
    | "kill"
    | "killResident"
    | "stop";
  residentId?: string;
  windowId?: string;
  scopeId?: string;
  headId?: string | null;
  receipt?: {
    residentId: string;
    windowId: string;
    generation: number;
    dispatchId: string;
  };
};

function requireString(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`missing ${field}`);
  return value;
}

function execute(command: HostCommand): unknown {
  switch (command.op) {
    case "open":
      return sessions.open(requireString(command.residentId, "residentId"), {
        context: null,
        ...(command.scopeId === undefined ? {} : { scopeId: command.scopeId }),
        ...(command.windowId === undefined ? {} : { windowId: command.windowId }),
      });
    case "get":
      return sessions.get(requireString(command.windowId, "windowId"));
    case "getArchived":
      return sessions.getArchived(requireString(command.windowId, "windowId"));
    case "setHead":
      sessions.setHead(requireString(command.windowId, "windowId"), command.headId ?? null);
      return null;
    case "issueDispatch":
      return sessions.issueDispatch(requireString(command.windowId, "windowId"));
    case "belongs":
      if (command.receipt === undefined) throw new Error("missing receipt");
      return sessions.belongsToActiveWindow(command.receipt);
    case "kill":
      return sessions.kill(requireString(command.windowId, "windowId"));
    case "killResident":
      return sessions.killResident(requireString(command.residentId, "residentId"));
    case "stop":
      return null;
  }
}

process.on("message", (raw) => {
  const command = raw as HostCommand;
  try {
    const value = execute(command);
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

process.send?.({ type: "ready", pid: process.pid });
