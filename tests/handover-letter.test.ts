import { describe, expect, it } from "vitest";
import {
  BREATH_ENTRY,
  MANUAL_BREATH_COMMANDS,
  parseManualBreath,
  thresholdBreath,
} from "../src/session/breath-trigger.ts";
import {
  DEFAULT_LETTER_TOKEN_LIMIT,
  LETTER_SCHEMA_INVALID,
  LetterSchemaError,
  estimateTokens,
  formatAuthor,
  sealLetter,
} from "../src/session/handover-letter.ts";
import { PRIVATE_SCOPE, SessionRegistry } from "../src/session/session-registry.ts";

const NOW = "2026-08-22T00:00:00.000Z";

function ctx(overrides: Partial<Parameters<typeof sealLetter>[1]> = {}) {
  return {
    residentId: "resident-a",
    windowId: "w_01J000000000000000000000",
    generation: 3,
    now: NOW,
    ...overrides,
  };
}

function draft(overrides: Partial<Parameters<typeof sealLetter>[0]> = {}) {
  return {
    title: "换气与交接信：泳道 3 开工",
    state: [{ tier: "fact" as const, body: "改了 session/ 下两个文件，测试全绿" }],
    intent: [{ tier: "judgment" as const, body: "先做单测那批，注入那半等装配器" }],
    ...overrides,
  };
}

describe("MV-D03 手动入口统一", () => {
  it("/new、/clear、/compact 映射到同一状态机入口，无 compact 旁路", () => {
    const results = MANUAL_BREATH_COMMANDS.map((command) => parseManualBreath(command));

    for (const result of results) {
      expect(result).not.toBeNull();
      expect(result?.state).toBe(BREATH_ENTRY);
      expect(result?.source).toBe("manual");
    }
    // 判红样例：给 /compact 单开一条状态（如 "compacting"）会让这条断言塌掉。
    expect(new Set(results.map((r) => r?.state)).size).toBe(1);
    expect(MANUAL_BREATH_COMMANDS).toEqual(["/new", "/clear", "/compact"]);
  });

  it("手动触发与阈值触发进同一个 state，只有 source 不同", () => {
    const manual = parseManualBreath("/compact");
    const threshold = thresholdBreath();

    expect(manual?.state).toBe(threshold.state);
    expect(manual?.source).toBe("manual");
    expect(threshold.source).toBe("threshold");
    expect(threshold.command).toBeNull();
  });

  it("大小写、首尾空白与带参数形式都不绕过入口", () => {
    expect(parseManualBreath("  /Compact  ")?.state).toBe(BREATH_ENTRY);
    expect(parseManualBreath("/compact 保留最近 20 条")?.command).toBe("/compact");
    expect(parseManualBreath("/compactify")).toBeNull();
    expect(parseManualBreath("这句话里有 /clear 但不是命令")).toBeNull();
  });
});

describe("MV-D05 标题必填即召回锚点", () => {
  it("无标题的信写入被拒", () => {
    expect(() => sealLetter(draft({ title: "" }), ctx())).toThrow(LetterSchemaError);
    expect(() => sealLetter(draft({ title: "   " }), ctx())).toThrow(/标题必填/);
  });

  it("标题落进封缄结果并去掉首尾空白", () => {
    expect(sealLetter(draft({ title: "  开工  " }), ctx()).title).toBe("开工");
  });
});

describe("MV-D06 三档标注条目级", () => {
  it("tier 不在三档内的条目被拒，错误信息给出合法档位", () => {
    const bad = draft({ intent: [{ tier: "vibes" as never, body: "随便写写" }] });

    expect(() => sealLetter(bad, ctx())).toThrow(/commitment \| fact \| judgment/);
  });

  it("一条只装一档：塞 tiers 多档字段被拒", () => {
    const bad = draft({
      state: [{ tier: "fact", body: "既是事实也是判断", tiers: ["fact", "judgment"] } as never],
    });

    expect(() => sealLetter(bad, ctx())).toThrow(/一条只装一档/);
  });

  it("intent 半每条盖当刻亲笔章：author = residentId + 写下它的那一代", () => {
    const sealed = sealLetter(draft(), ctx({ generation: 3 }));

    expect(sealed.intent[0]?.author).toBe(formatAuthor("resident-a", 3));
    expect(sealed.intent[0]?.writtenAt).toBe(NOW);
    // 亲笔纪律只约束 intent 半：state 半允许脚本生成，不盖章。
    expect(sealed.state[0]).not.toHaveProperty("author");
  });

  it("commitment 条目必须带 ledgerSeq 指针，且指针只属于 commitment 档", () => {
    expect(() =>
      sealLetter(draft({ state: [{ tier: "commitment", body: "每天问她吃药没有" }] }), ctx()),
    ).toThrow(/缺 ledgerSeq/);

    expect(() =>
      sealLetter(draft({ state: [{ tier: "fact", body: "测试全绿", ledgerSeq: 7 }] }), ctx()),
    ).toThrow(/只有 commitment 档可带 ledgerSeq/);

    const ok = sealLetter(
      draft({ state: [{ tier: "commitment", body: "每天问她吃药没有", ledgerSeq: 7 }] }),
      ctx(),
    );
    expect(ok.state[0]?.ledgerSeq).toBe(7);
  });

  it("承诺在信里不可被作废：带作废标记的条目硬拒，不是静默忽略", () => {
    for (const field of ["revoked", "void", "superseded", "cancelled"]) {
      const bad = draft({
        state: [{ tier: "commitment", body: "旧承诺", ledgerSeq: 7, [field]: true } as never],
      });

      expect(() => sealLetter(bad, ctx())).toThrow(LetterSchemaError);
      expect(() => sealLetter(bad, ctx())).toThrow(/supersede/);
    }
  });

  it("空 body 的条目被拒，错误信息指到具体是哪一半的第几条", () => {
    const bad = draft({ intent: [{ tier: "judgment", body: "   " }] });

    expect(() => sealLetter(bad, ctx())).toThrow(/intent\[0\]/);
  });
});

describe("MV-D08 信长度上限", () => {
  it("超上限被拒，错误信息同时指明上限值与当前实际长度", () => {
    const long = "字".repeat(DEFAULT_LETTER_TOKEN_LIMIT + 10);

    let caught: unknown;
    try {
      sealLetter(draft({ state: [{ tier: "fact", body: long }] }), ctx());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LetterSchemaError);
    const message = (caught as Error).message;
    expect(message).toContain(String(DEFAULT_LETTER_TOKEN_LIMIT));
    expect(message).toMatch(/当前 \d+ token/);
    expect(message).toContain(LETTER_SCHEMA_INVALID);
  });

  it("上限可配，度量口可注入——2000 是估算不是精确值", () => {
    const oneTokenPerCall = () => 1;

    expect(() => sealLetter(draft(), ctx({ tokenLimit: 2 }))).toThrow(/上限 2 token/);
    // 三段（标题 + state 一条 + intent 一条）各计 1，注入度量后正好卡在上限内。
    expect(sealLetter(draft(), ctx({ tokenLimit: 3, measureTokens: oneTokenPerCall })).title).toBe(
      "换气与交接信：泳道 3 开工",
    );
  });

  it("估算口径：CJK 一字一 token，ASCII 约四字符一 token", () => {
    expect(estimateTokens("一二三")).toBe(3);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("封缄结果与草稿互不别名", () => {
  it("封缄后改草稿不脏信", () => {
    const source = draft();
    const sealed = sealLetter(source, ctx());

    const firstStateItem = source.state[0];
    if (firstStateItem === undefined) {
      throw new Error("夹具自身坏了：草稿 state 半应有一条");
    }
    firstStateItem.body = "被改掉了";

    expect(sealed.state[0]?.body).toBe("改了 session/ 下两个文件，测试全绿");
    expect(sealed.windowId).toBe(ctx().windowId);
    expect(sealed.generation).toBe(3);
  });
});

describe("MV-D10 换气不改窗身份", () => {
  it("换气前后 windowId 逐字不变，只有 generation + 1", () => {
    const sessions = new SessionRegistry<null>();
    const before = sessions.open("resident-a", { context: null });

    sessions.kill(before.windowId);
    const after = sessions.open("resident-a", { windowId: before.windowId, context: null });

    expect(after.windowId).toBe(before.windowId);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.scopeId).toBe(PRIVATE_SCOPE);
    // 判红样例①：换气流程中重新签发 windowId。
    expect(sessions.windowsOf("resident-a")).toHaveLength(1);
  });

  it("换气后旧 windowId 仍解析到同一扇窗，不出现悬空引用", () => {
    const sessions = new SessionRegistry<null>();
    const before = sessions.open("resident-a", { headId: "node-1", context: null });
    const heldReference = before.windowId;

    sessions.kill(heldReference);
    sessions.open("resident-a", { windowId: heldReference, context: null });

    // 判红样例②：换气后旧 windowId 查不到该窗。
    expect(sessions.isActive(heldReference)).toBe(true);
    expect(sessions.get(heldReference)?.residentId).toBe("resident-a");
  });

  it("旧代际的派发回执在换气后被丢弃，但窗身份不变", () => {
    const sessions = new SessionRegistry<null>();
    const before = sessions.open("resident-a", { context: null });
    const staleReceipt = sessions.issueDispatch(before.windowId);

    sessions.kill(before.windowId);
    const after = sessions.open("resident-a", { windowId: before.windowId, context: null });
    const freshReceipt = sessions.issueDispatch(after.windowId);

    expect(staleReceipt.windowId).toBe(freshReceipt.windowId);
    expect(sessions.belongsToActiveWindow(staleReceipt)).toBe(false);
    expect(sessions.belongsToActiveWindow(freshReceipt)).toBe(true);
  });
});
