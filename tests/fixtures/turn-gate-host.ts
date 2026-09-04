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

const dataDir = process.env.MIST_TURN_GATE_DATADIR;
// 给了 dataDir 就是「落盘宿主」形态：ResidentStore 与 FactLedger 同目录共存
// （各自认领各自的后缀），供父进程 SIGKILL 后原目录拉起，验猝死不续接。
const ledger = dataDir === undefined ? new FactLedger() : new FactLedger({ dataDir });
const events: TurnGateEvent[] = [];
const logger: TurnEventLogger = {
  log: (event) => {
    events.push(event);
  },
};

// --- A 窗通道：生产 MistDriver，say 的注入文本经捕获型 reply 留给父进程断言 ---
let lastDriverPrompt: string | null = null;
const driver = createDriver({
  ...(dataDir === undefined ? {} : { dataDir }),
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
    | "remember"
    | "commit"
    | "recall"
    | "killSession"
    | "appendRuling"
    | "appendRulingFromB"
    | "supersede"
    | "supersedeFromB"
    | "entries"
    | "currentSet"
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
  content?: string;
  commitment?: string;
  query?: string;
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
    case "remember":
      return driver.remember(
        requireString(command.residentId, "residentId"),
        requireString(command.content, "content"),
      );
    case "commit":
      await driver.commit(
        requireString(command.residentId, "residentId"),
        requireString(command.commitment, "commitment"),
      );
      return null;
    case "recall":
      return driver.recall(
        requireString(command.residentId, "residentId"),
        requireString(command.query, "query"),
      );
    case "killSession":
      await driver.killSession(requireString(command.residentId, "residentId"));
      return null;
    case "appendRuling":
      return ledger.append(requireString(command.residentId, "residentId"), {
        author: requireString(command.author, "author"),
        kind: command.kind ?? "ruling",
        body: requireString(command.body, "body"),
      });
    // C04：B 窗署名的裁定级写入——同一个 append 入口，只多一个发起方。
    // 窗「自查与否」在这条路径上不存在：装置故意不做任何前置检查，
    // 拦不拦全看账侧。
    case "appendRulingFromB": {
      const residentId = requireString(command.residentId, "residentId");
      return ledger.append(
        residentId,
        {
          author: requireString(command.author, "author"),
          kind: command.kind ?? "ruling",
          body: requireString(command.body, "body"),
        },
        { viewportId: windowBOf(residentId) },
      );
    }
    case "supersede":
      return ledger.supersede(
        requireString(command.residentId, "residentId"),
        command.targetSeq ?? -1,
        {
          author: requireString(command.author, "author"),
          reason: requireString(command.reason, "reason"),
        },
      );
    case "supersedeFromB": {
      const residentId = requireString(command.residentId, "residentId");
      return ledger.supersede(
        residentId,
        command.targetSeq ?? -1,
        {
          author: requireString(command.author, "author"),
          reason: requireString(command.reason, "reason"),
        },
        { viewportId: windowBOf(residentId) },
      );
    }
    case "entries":
      return ledger.entries(requireString(command.residentId, "residentId"));
    case "currentSet":
      return ledger.currentSet(requireString(command.residentId, "residentId"));
    case "openWindowB": {
      const residentId = requireString(command.residentId, "residentId");
      // 两个注册表各发各的号也不撞：生产发号是 w_ + ULID（进程间不可撞），
      // 撞号重试的拐杖已随 F5 拆除。
      const opened = sessionsB.open(residentId, { context: null });
      const baseline = ledger.openViewport(residentId, opened.windowId);
      windowsB.set(residentId, opened.windowId);
      return { windowId: opened.windowId, baseline };
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
