import { describe, expect, it } from "vitest";
import {
  BreathCycle,
  BreathCycleError,
  type BreathNotification,
} from "../src/session/breath-cycle.ts";
import type { SealedLetter } from "../src/session/handover-letter.ts";
import { PRIVATE_SCOPE, SessionRegistry } from "../src/session/session-registry.ts";

const NOW = "2026-08-24T00:00:00.000Z";

interface Ctx {
  notes: string[];
  letter?: SealedLetter;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    title: "泳道 3 第二刀：换气流程接线",
    state: [{ tier: "fact" as const, body: "接了 kill+open，信先落时间线" }],
    intent: [{ tier: "judgment" as const, body: "宁可不换代，不可无信换代" }],
    ...overrides,
  };
}

/** 一套接好线的换气流程 + 它落下的痕迹，供各条断言取用。 */
function harness(overrides: Partial<Record<string, unknown>> = {}) {
  const registry = new SessionRegistry<Ctx>();
  const timeline: SealedLetter[] = [];
  const notices: BreathNotification[] = [];
  const cycle = new BreathCycle<Ctx>({
    registry,
    appendLetter: (letter) => {
      timeline.push(letter);
    },
    injectLetter: (context, letter) => ({ ...context, letter }),
    notify: (event) => {
      notices.push(event);
    },
    now: () => NOW,
    ...overrides,
  });
  const window = registry.open("resident-a", { context: { notes: [] } });
  return { registry, timeline, notices, cycle, window };
}

describe("MV-D10 换气不改窗身份", () => {
  it("换气前后 windowId 逐字不变，只有 generation + 1", () => {
    const { cycle, window } = harness();

    const result = cycle.breathe(window.windowId, draft());

    expect(result.window.windowId).toBe(window.windowId);
    expect(result.window.generation).toBe(window.generation + 1);
    expect(result.window.residentId).toBe(window.residentId);
    expect(result.window.scopeId).toBe(PRIVATE_SCOPE);
  });

  it("换气后旧 windowId 仍解析到同一扇活窗，不留悬空引用", () => {
    const { registry, cycle, window } = harness();
    const id = window.windowId;

    cycle.breathe(id, draft());

    // 判红样例：换气流程若重新签发 windowId，这三条一起塌。
    expect(registry.isActive(id)).toBe(true);
    expect(registry.get(id)?.windowId).toBe(id);
    expect(registry.getArchived(id)).toBeUndefined();
  });

  it("换气三次，windowId 始终是同一个，代际单调递增", () => {
    const { cycle, window } = harness();
    const id = window.windowId;

    const generations = [1, 2, 3].map(() => cycle.breathe(id, draft()).window.generation);

    expect(generations).toEqual([2, 3, 4]);
  });
});

describe("MV-D04 信随新代注入", () => {
  it("新代醒来时上下文里信全文已在，无需任何工具调用", () => {
    const { cycle, window } = harness();

    const result = cycle.breathe(window.windowId, draft());

    expect(result.window.context.letter).toBeDefined();
    expect(result.window.context.letter?.title).toBe("泳道 3 第二刀：换气流程接线");
    expect(result.window.context.letter?.intent[0]?.body).toBe("宁可不换代，不可无信换代");
  });

  it("信盖的是写信那一代的章，不是醒来那一代的", () => {
    const { cycle, window } = harness();

    const result = cycle.breathe(window.windowId, draft());

    // 窗从 generation 1 换到 2；信是 1 写的。
    expect(result.letter.generation).toBe(1);
    expect(result.letter.intent[0]?.author).toBe("resident-a#1");
    expect(result.window.generation).toBe(2);
  });

  it("注入不脏旧上下文：新代改包不影响换气前那份", () => {
    const { cycle, window } = harness();
    const before = window.context;

    cycle.breathe(window.windowId, draft());

    expect(before).not.toHaveProperty("letter");
  });
});

describe("信先落定，再换代", () => {
  it("信落时间线的顺序在换代之前——落盘失败则一代都不换", () => {
    const { registry, cycle, window, notices } = harness({
      appendLetter: () => {
        throw new Error("timeline is full");
      },
    });
    const id = window.windowId;

    expect(() => cycle.breathe(id, draft())).toThrow(BreathCycleError);

    // 窗一根汗毛没动：还活着，还是第一代。
    expect(registry.isActive(id)).toBe(true);
    expect(registry.get(id)?.generation).toBe(1);
    expect(notices.at(-1)).toMatchObject({ kind: "failed", stage: "append" });
  });

  it("注入抛错时窗仍活、代际不变——kill 不许先于注入求值（cursor 08-25）", () => {
    // 病根:参数在调用前求值。injectLetter 若写在 open(...) 的参数位上,
    // 它抛错的落点是 kill 之后、open 之前——窗已归档,新代没开,
    // 恰好违反模块头的「失败且窗没动过」。这条钉住"注入先算完,再动窗"。
    const { registry, cycle, window, timeline, notices } = harness({
      injectLetter: () => {
        throw new Error("letter does not fit this context");
      },
    });
    const id = window.windowId;

    expect(() => cycle.breathe(id, draft())).toThrow(BreathCycleError);

    // 窗一根汗毛没动:还活着,还是第一代。
    expect(registry.isActive(id)).toBe(true);
    expect(registry.get(id)?.generation).toBe(1);
    // 信已落时间线(顺序在注入之前,这是既定语义);失败档位是 inject 不是 swap。
    expect(timeline).toHaveLength(1);
    expect(notices.at(-1)).toMatchObject({
      kind: "failed",
      stage: "inject",
      windowRecovered: true,
    });
  });

  it("信校验不过时停在封缄这一步，时间线一个字都不写", () => {
    const { registry, timeline, cycle, window, notices } = harness();
    const id = window.windowId;

    expect(() => cycle.breathe(id, draft({ title: "   " }))).toThrow(/LETTER_SCHEMA_INVALID/);

    expect(timeline).toHaveLength(0);
    expect(registry.get(id)?.generation).toBe(1);
    expect(notices.at(-1)).toMatchObject({ kind: "failed", stage: "seal" });
  });

  it("成功路径下，信进时间线的那一封与注入新代的是同一封", () => {
    const { timeline, cycle, window } = harness();

    const result = cycle.breathe(window.windowId, draft());

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toBe(result.letter);
    expect(result.window.context.letter).toBe(result.letter);
  });
});

describe("MV-D09 换气失败必须外显", () => {
  it("失败产生对人可见的通知，不是只落一个日志字段", () => {
    const { cycle, window, notices } = harness({
      appendLetter: () => {
        throw new Error("disk is on fire");
      },
    });

    expect(() => cycle.breathe(window.windowId, draft())).toThrow(BreathCycleError);

    const failure = notices.at(-1);
    expect(failure?.kind).toBe("failed");
    expect(failure).toMatchObject({
      windowId: window.windowId,
      generation: 1,
      stage: "append",
      reason: "disk is on fire",
    });
  });

  it("失败后的下一次阈值穿越必须重新发预告，不因「本周期已发过」而静默", () => {
    const { cycle, window, notices } = harness({
      appendLetter: () => {
        throw new Error("still on fire");
      },
    });
    const id = window.windowId;

    expect(cycle.announce(id)).toBe(true);
    // 同一周期内重复穿越只发一次——这是去重，正常。
    expect(cycle.announce(id)).toBe(false);

    expect(() => cycle.breathe(id, draft())).toThrow(BreathCycleError);

    // 判红样例：失败若不清预告记号，这一条会返回 false，
    // 于是连续失败对人完全静默。
    expect(cycle.announce(id)).toBe(true);

    const announced = notices.filter((event) => event.kind === "announced");
    expect(announced).toHaveLength(2);
  });

  it("换气成功也清预告记号：下一周期的穿越照常发", () => {
    const { cycle, window, notices } = harness();
    const id = window.windowId;

    expect(cycle.announce(id)).toBe(true);
    cycle.breathe(id, draft());
    expect(cycle.announce(id)).toBe(true);

    expect(notices.filter((event) => event.kind === "announced")).toHaveLength(2);
    expect(notices.filter((event) => event.kind === "completed")).toHaveLength(1);
  });

  it("成功也通知，且带着新旧两代——人要能分清换到了第几代", () => {
    const { cycle, window, notices } = harness();

    cycle.breathe(window.windowId, draft());

    expect(notices.at(-1)).toMatchObject({
      kind: "completed",
      windowId: window.windowId,
      fromGeneration: 1,
      toGeneration: 2,
      letterTitle: "泳道 3 第二刀：换气流程接线",
    });
  });

  it("对不存在的窗换气：报错且外显，不静默返回", () => {
    const { cycle, notices } = harness();

    expect(() => cycle.breathe("w_not_a_window", draft())).toThrow(/window is not live/);

    expect(notices.at(-1)).toMatchObject({
      kind: "failed",
      stage: "swap",
      windowId: "w_not_a_window",
    });
  });

  it("对不存在的窗发预告：抛错而不是假装发过", () => {
    const { cycle } = harness();

    expect(() => cycle.announce("w_not_a_window")).toThrow(BreathCycleError);
  });
});

describe("同住户多窗互不串气", () => {
  it("换一扇窗的气，不动另一扇窗的代际", () => {
    const { registry, cycle, window } = harness();
    const other = registry.open("resident-a", { context: { notes: ["另一扇"] } });

    cycle.breathe(window.windowId, draft());

    expect(other.windowId).not.toBe(window.windowId);
    expect(registry.get(other.windowId)?.generation).toBe(1);
    expect(registry.get(other.windowId)?.context.letter).toBeUndefined();
  });
});
