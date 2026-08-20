/**
 * 开工闸集成宿主：子进程里装配生产件——MistDriver（带 factLedger + 收集型
 * logger）、FactLedger、SessionRegistry、MessageTreeService（B 窗通道），
 * 父进程经 IPC 驱动，覆盖验收清单 C 区的 [集成] 半格。
 *
 * 形状仿 session-registry-host.ts。A 窗走 driver 自己的窗绑定（生产懒开窗
 * 路径），B 窗由 fixture 直接 registry.open + ledger.openViewport——同一本账、
 * 同一道闸（ViewportTurnGate），只有装配方不同。
 *
 * 测试数据全为虚构占位（AGENTS.md：住户内容不进仓库）。
 */

import { createDriver } from "../../src/acceptance-driver.ts";
import {
  MessageTreeService,
  MessageTreeStore,
  type TurnGate,
} from "../../src/message-tree/index.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import {
  type TurnEventLogger,
  type TurnGateEvent,
  ViewportTurnGate,
} from "../../src/session/turn-gate.ts";
import { type FactKind, FactLedger, type GapProbe } from "../../src/store/fact-ledger.ts";

const ledger = new FactLedger();
const events: TurnGateEvent[] = [];
const logger: TurnEventLogger = {
  log: (event) => {
    events.push(event);
  },
};

// --- A 窗通道：生产 MistDriver，say 的注入文本经捕获型 reply 留给父进程断言 ---
let lastDriverPrompt: string | null = null;
const driver = createDriver({
  factLedger: ledger,
  turnEventLogger: logger,
  reply: (_residentId, message) => {
    lastDriverPrompt = message;
    return "司机窗哑回应";
  },
});

// --- B 窗通道：同一本账、同一道闸，fixture 自己装配的生产 Service ---
const sessionsB = new SessionRegistry<null>();
const storeB = new MessageTreeStore();
const windowsB = new Map<string, string>();
let lastBPrompt: string | null = null;

const realGateB = new ViewportTurnGate(ledger, {
  logger,
  generationOf: (windowId) => sessionsB.get(windowId)?.generation ?? null,
});

// MV-C05 故障注入：闸门正常拉取、正常发凭证，但 commit 到不了账（回执丢失）。
let commitDropped = false;
const gateB: TurnGate = {
  beforeTurn: (residentId, windowId) => {
    const pass = realGateB.beforeTurn(residentId, windowId);
    if (!commitDropped) return pass;
    return { contextPrefix: pass.contextPrefix, commit: () => {} };
  },
};

const serviceB = new MessageTreeService(
  storeB,
  {
    getHead: (windowId) => sessionsB.getHead(windowId),
    setHead: (windowId, headId) => sessionsB.setHead(windowId, headId),
  },
  {
    assistantReply: (_residentId, message) => {
      lastBPrompt = message;
      return "B 窗哑回应";
    },
    turnGate: gateB,
  },
);

// MV-C03 故障注入：查账必返 unknown。「查不到」与「查到是零」在 GapProbe
// 类型上是两个值，注入只造 unknown，造不出假零。
let probeFails = false;
const realProbeGap = ledger.probeGap.bind(ledger);
ledger.probeGap = (residentId, windowId): GapProbe =>
  probeFails ? { status: "unknown", cause: "注入的查账失败" } : realProbeGap(residentId, windowId);

type HostCommand = {
  requestId: string;
  op:
    | "createResident"
    | "appendRuling"
    | "supersede"
    | "entries"
    | "openWindowB"
    | "sayOn"
    | "sayOnB"
    | "probe"
    | "ackedSeq"
    | "bootpack"
    | "history"
    | "logEvents"
    | "failProbe"
    | "dropCommit"
    | "stop";
  residentId?: string;
  windowId?: string;
  name?: string;
  author?: string;
  kind?: FactKind;
  body?: string;
  targetSeq?: number;
  reason?: string;
  message?: string;
  on?: boolean;
};

function requireString(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`missing ${field}`);
  return value;
}

function windowBOf(residentId: string): string {
  const windowId = windowsB.get(residentId);
  if (windowId === undefined) throw new Error(`no B window for ${residentId}`);
  return windowId;
}

async function execute(command: HostCommand): Promise<unknown> {
  switch (command.op) {
    case "createResident": {
      const residentId = await driver.createResident(requireString(command.name, "name"));
      // B 窗通道用独立的消息树存储；两通道共享的只有那本账。
      storeB.createRoom(residentId);
      return { residentId };
    }
    case "appendRuling":
      return ledger.append(requireString(command.residentId, "residentId"), {
        author: requireString(command.author, "author"),
        kind: command.kind ?? "ruling",
        body: requireString(command.body, "body"),
      });
    case "supersede":
      return ledger.supersede(
        requireString(command.residentId, "residentId"),
        command.targetSeq ?? -1,
        {
          author: requireString(command.author, "author"),
          reason: requireString(command.reason, "reason"),
        },
      );
    case "entries":
      return ledger.entries(requireString(command.residentId, "residentId"));
    case "openWindowB": {
      const residentId = requireString(command.residentId, "residentId");
      // 两个注册表各自发号，windowId 可能撞车（账的 ack 行按 windowId 索引，
      // 撞上就是两扇窗共用一行确认位）。撞了就把这扇窗归档、重新开，
      // 直到拿到账上没占过的 id——ack 行才是窗身份的真源。
      for (;;) {
        const opened = sessionsB.open(residentId, { context: null });
        try {
          const baseline = ledger.openViewport(residentId, opened.windowId);
          windowsB.set(residentId, opened.windowId);
          return { windowId: opened.windowId, baseline };
        } catch (error) {
          sessionsB.kill(opened.windowId);
          if (error instanceof Error && error.message.includes("ack row already exists")) {
            continue;
          }
          throw error;
        }
      }
    }
    case "sayOn": {
      const node = await driver.say(
        requireString(command.residentId, "residentId"),
        requireString(command.message, "message"),
      );
      return { node, prompt: lastDriverPrompt };
    }
    case "sayOnB": {
      const residentId = requireString(command.residentId, "residentId");
      const node = await serviceB.say(
        residentId,
        requireString(command.message, "message"),
        windowBOf(residentId),
      );
      return { node, prompt: lastBPrompt };
    }
    case "probe":
      return ledger.probeGap(
        requireString(command.residentId, "residentId"),
        requireString(command.windowId, "windowId"),
      );
    case "ackedSeq":
      return ledger.ackedSeq(
        requireString(command.residentId, "residentId"),
        requireString(command.windowId, "windowId"),
      );
    case "bootpack":
      return driver.buildBootPack(requireString(command.residentId, "residentId"));
    case "history":
      return driver.history(requireString(command.residentId, "residentId"));
    case "logEvents":
      return events;
    case "failProbe":
      probeFails = command.on === true;
      return null;
    case "dropCommit":
      commitDropped = command.on === true;
      return null;
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
        },
      });
    }
  })();
});

process.send?.({ type: "ready", pid: process.pid });
