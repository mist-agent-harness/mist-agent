/**
 * 换气集成宿主：子进程里装配生产件——SessionRegistry、MessageTreeStore +
 * Service、ViewportTurnGate（接阈值计量口）、BreathCycle（接流水卫生检查），
 * 父进程经 IPC 驱动，覆盖验收清单 D 区的 [集成] 半格
 * （MV-D01/D02/D04 后半/D07/D07b）。
 *
 * 形状仿 turn-gate-host.ts。关键装配口径：
 *
 * - 代际边界用插入序切片：本代流水 = 插入序下标 ≥ boundary 的节点。换气与
 *   猝死重开时 boundary 推到当前末尾——旧代流水（含残骸）随之出切片，
 *   不进新代的用量核算与卫生检查（MV-D07：猝死窗流水不自动注入）。
 * - 上下文用量计（MV-D01/D04）：口径 = 本代流水 + 在途 notes，**不含交接信**
 *   （D8 补记二）。信经 injectLetter 进 context.letter，用量计不看它。
 * - 畸形残骸进不了 MessageTreeStore（契约闸会拒），所以畸形注入走 fixture
 *   自管的原始碎片带，叠在流水切片之上交给卫生检查——它模拟的是异源/
 *   崩溃写入留下的、绕过店内校验的流水。合法残骸（半截回合）用
 *   importTree 落真节点。
 *
 * 测试数据全为虚构占位（AGENTS.md：住户内容不进仓库）。
 */

import { MessageTreeService, MessageTreeStore } from "../../src/message-tree/index.ts";
import {
  CanonicalStreamStore,
  CanonicalStreamWriter,
  HostLifecycleFailurePort,
} from "../../src/one-stream/index.ts";
import { BreathCycle, type BreathNotification } from "../../src/session/breath-cycle.ts";
import {
  type LetterDraft,
  type SealedLetter,
  estimateTokens,
} from "../../src/session/handover-letter.ts";
import {
  type ActiveWindow,
  type OpenOptions,
  SessionRegistry,
} from "../../src/session/session-registry.ts";
import { type TurnGateEvent, ViewportTurnGate } from "../../src/session/turn-gate.ts";
import { FactLedger } from "../../src/store/fact-ledger.ts";

interface Ctx {
  notes: string[];
  letter?: SealedLetter;
}

class FixtureSessionRegistry extends SessionRegistry<Ctx> {
  #failNextReopen = false;

  failNextReopen(): void {
    this.#failNextReopen = true;
  }

  override open(residentId: string, options: OpenOptions<Ctx>): ActiveWindow<Ctx> {
    if (options.windowId !== undefined && this.#failNextReopen) {
      this.#failNextReopen = false;
      throw new Error("injected viewport reopen failure");
    }
    return super.open(residentId, options);
  }
}

const registry = new FixtureSessionRegistry();
const ledger = new FactLedger();
const store = new MessageTreeStore();
const events: TurnGateEvent[] = [];
const notices: BreathNotification[] = [];
const timeline: SealedLetter[] = [];
const debrisLog: string[] = [];
const canonicalStore = new CanonicalStreamStore();
const canonicalWriter = new CanonicalStreamWriter(canonicalStore);
const lifecycleFailures = new HostLifecycleFailurePort(canonicalWriter, {
  authoritySource: { kind: "host", id: "mist-host" },
});

/** windowId → 本代流水的插入序起点。 */
const boundaries = new Map<string, number>();
/** windowId → 注入的原始碎片（畸形结构的载体，见模块头）。 */
const rawDebris = new Map<string, unknown[]>();
/** 已在账上开过确认位的 windowId——openViewport 对同一窗只能开一次。 */
const viewportRows = new Set<string>();
let remnantSeq = 0;
let breathAttemptSeq = 0;
let failNextAppend = false;

function requireLive(windowId: string): ActiveWindow<Ctx> {
  const window = registry.get(windowId);
  if (window === undefined) throw new Error(`window is not live: ${windowId}`);
  return window;
}

/** 本代流水切片（不含碎片带）。 */
function flowSlice(window: ActiveWindow<Ctx>) {
  return store.history(window.residentId).slice(boundaries.get(window.windowId) ?? 0);
}

/**
 * 上下文用量计（MV-D01）：本代流水 + 在途 notes。交接信不计入
 * （MV-D04 / D8 补记二）——context.letter 全文就在眼前，本计不看它。
 */
function usageOf(windowId: string): number | null {
  const window = registry.get(windowId);
  if (window === undefined) return null;
  const flowTokens = flowSlice(window).reduce((sum, node) => sum + estimateTokens(node.content), 0);
  const noteTokens = window.context.notes.reduce((sum, note) => sum + estimateTokens(note), 0);
  return flowTokens + noteTokens;
}

const gate = new ViewportTurnGate(ledger, {
  logger: {
    log: (event) => {
      events.push(event);
    },
  },
  generationOf: (windowId) => registry.get(windowId)?.generation ?? null,
  breath: { usageOf },
});

let lastPrompt: string | null = null;
const service = new MessageTreeService(
  store,
  {
    getHead: (windowId) => registry.getHead(windowId),
    setHead: (windowId, headId) => registry.setHead(windowId, headId),
  },
  {
    assistantReply: (_residentId, message) => {
      lastPrompt = message;
      return "换气宿主哑回应";
    },
    turnGate: gate,
  },
);

const cycle = new BreathCycle<Ctx>({
  registry,
  appendLetter: (letter) => {
    if (failNextAppend) {
      failNextAppend = false;
      throw new Error("injected timeline append failure");
    }
    timeline.push(letter);
  },
  injectLetter: (context, letter) => ({ ...context, letter }),
  notify: (event) => {
    notices.push(event);
  },
  flowOf: (window) => [...flowSlice(window), ...(rawDebris.get(window.windowId) ?? [])],
  now: () => new Date().toISOString(),
});

type HostCommand = {
  requestId: string;
  op:
    | "open"
    | "say"
    | "usage"
    | "configureThreshold"
    | "announce"
    | "breathe"
    | "context"
    | "history"
    | "archived"
    | "suddenKill"
    | "reopen"
    | "injectRemnant"
    | "injectDebris"
    | "quarantineDebris"
    | "notices"
    | "events"
    | "debrisLog"
    | "timeline"
    | "canonicalEvents"
    | "failNextAppend"
    | "failNextSwap"
    | "stop";
  residentId?: string;
  windowId?: string;
  message?: string;
  content?: string;
  tokens?: number;
  draft?: LetterDraft;
  debris?: unknown[];
};

function requireString(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`missing ${field}`);
  return value;
}

async function execute(command: HostCommand): Promise<unknown> {
  switch (command.op) {
    case "open": {
      const residentId = requireString(command.residentId, "residentId");
      ledger.createLedger(residentId);
      if (!canonicalStore.has(residentId)) canonicalStore.createStream(residentId);
      store.createRoom(residentId);
      const window = registry.open(residentId, { context: { notes: [] } });
      ledger.openViewport(residentId, window.windowId);
      viewportRows.add(window.windowId);
      boundaries.set(window.windowId, store.history(residentId).length);
      return { windowId: window.windowId, generation: window.generation };
    }
    case "say": {
      const window = requireLive(requireString(command.windowId, "windowId"));
      const node = await service.say(
        window.residentId,
        requireString(command.message, "message"),
        window.windowId,
      );
      return { node, prompt: lastPrompt };
    }
    case "usage":
      return usageOf(requireString(command.windowId, "windowId"));
    case "configureThreshold":
      gate.configureThreshold(
        requireString(command.windowId, "windowId"),
        command.tokens ?? Number.NaN,
      );
      return null;
    case "announce":
      return cycle.announce(requireString(command.windowId, "windowId"));
    case "breathe": {
      const windowId = requireString(command.windowId, "windowId");
      if (command.draft === undefined) throw new Error("missing draft");
      const before = requireLive(windowId);
      breathAttemptSeq += 1;
      const noticeStart = notices.length;
      let result: ReturnType<typeof cycle.breathe>;
      try {
        result = cycle.breathe(windowId, command.draft);
      } catch (error) {
        const failure = notices
          .slice(noticeStart)
          .findLast(
            (notice): notice is Extract<BreathNotification, { kind: "failed" }> =>
              notice.kind === "failed" &&
              notice.windowId === windowId &&
              notice.generation === before.generation,
          );
        if (failure === undefined) throw new Error("breath failed without a failure notice");
        await lifecycleFailures.submit({
          residentId: before.residentId,
          idempotencyKey: `breath:${windowId}:${before.generation}:${breathAttemptSeq}`,
          occurredAt: new Date().toISOString(),
          action: "breath",
          subject: { windowId, generation: before.generation },
          stage: failure.stage,
          reason: failure.reason,
          windowRecovered: failure.windowRecovered,
          handling: failure.windowRecovered
            ? { kind: "automatic-retry" }
            : {
                kind: "user-action",
                action: `Recover viewport ${windowId} before retrying breath`,
              },
        });
        throw error;
      }
      // 换代即边界：旧代流水（含残骸）出切片，不进新代的核算与检查。
      boundaries.set(windowId, store.history(result.window.residentId).length);
      return {
        windowId: result.window.windowId,
        generation: result.window.generation,
        letterTitle: result.letter.title,
      };
    }
    case "context":
      return requireLive(requireString(command.windowId, "windowId")).context;
    case "history":
      return store.history(requireString(command.residentId, "residentId"));
    case "archived":
      return registry.getArchived(requireString(command.windowId, "windowId")) ?? null;
    case "suddenKill":
      // 未及写信的猝死：没有 breathe、没有信，窗直接归档。
      return registry.kill(requireString(command.windowId, "windowId")) ?? null;
    case "reopen": {
      const archived = registry.getArchived(requireString(command.windowId, "windowId"));
      if (archived === undefined) throw new Error("target is not an archived window");
      // 猝死后的新代：干净上下文，不自动注入猝死窗流水（图纸 §4.1）。
      // 上一封交接信的注入归启动包装配，不是这条重开路径的事。
      const window = registry.open(archived.residentId, {
        windowId: archived.windowId,
        scopeId: archived.scopeId,
        headId: archived.headId,
        context: { notes: [] },
      });
      if (!viewportRows.has(window.windowId)) {
        ledger.openViewport(window.residentId, window.windowId);
        viewportRows.add(window.windowId);
      }
      boundaries.set(window.windowId, store.history(window.residentId).length);
      return { windowId: window.windowId, generation: window.generation };
    }
    case "injectRemnant": {
      const window = requireLive(requireString(command.windowId, "windowId"));
      // 回合中途猝死的合法残骸：user 节点落了，回应永远没落地。
      // importTree 走店内契约闸——能进去的就是合法形状，只是不完整。
      remnantSeq += 1;
      const id = `remnant-${remnantSeq}`;
      store.importTree(window.residentId, [
        {
          id,
          parentId: window.headId,
          role: "user",
          content: requireString(command.content, "content"),
          createdAt: new Date().toISOString(),
        },
      ]);
      return { id };
    }
    case "injectDebris":
      rawDebris.set(requireString(command.windowId, "windowId"), command.debris ?? []);
      return null;
    case "quarantineDebris": {
      const windowId = requireString(command.windowId, "windowId");
      const debris = rawDebris.get(windowId) ?? [];
      for (const item of debris) {
        debrisLog.push(`${windowId}: ${JSON.stringify(item)}`);
      }
      rawDebris.delete(windowId);
      return debris.length;
    }
    case "notices":
      return notices;
    case "events":
      return events;
    case "debrisLog":
      return debrisLog;
    case "timeline":
      return timeline;
    case "canonicalEvents":
      return canonicalStore.events(requireString(command.residentId, "residentId"));
    case "failNextAppend":
      failNextAppend = true;
      return null;
    case "failNextSwap":
      registry.failNextReopen();
      return null;
    case "stop":
      await canonicalWriter.close();
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
