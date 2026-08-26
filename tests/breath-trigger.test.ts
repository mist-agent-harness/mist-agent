import { describe, expect, it } from "vitest";
import { createDriver } from "../src/acceptance-driver.ts";
import {
  BREATH_COMMAND,
  BREATH_ENTRY,
  BreathCommandError,
  MANUAL_BREATH_COMMANDS,
  parseManualBreath,
  thresholdBreath,
} from "../src/session/breath-trigger.ts";
import { BreathThresholdError } from "../src/session/turn-gate.ts";

describe("MV-D03 手动入口统一", () => {
  it("/new、/clear、/compact 全部映射到同一状态机入口，不存在第四种手动结果", () => {
    const triggers = MANUAL_BREATH_COMMANDS.map((command) => {
      const trigger = parseManualBreath(command);
      expect(trigger).not.toBeNull();
      return trigger;
    });

    // 三条命令共用同一个 state 与 source，只差 command 字段——
    // 「入口统一」的字面意思；多出来的任何形状都是旁路。
    for (const [index, command] of MANUAL_BREATH_COMMANDS.entries()) {
      expect(triggers[index]).toEqual({ source: "manual", state: BREATH_ENTRY, command });
    }
    const shapes = new Set(triggers.map((trigger) => `${trigger?.source}:${trigger?.state}`));
    expect(shapes.size).toBe(1);
  });

  it("阈值触发与手动触发进的是同一个 state", () => {
    expect(thresholdBreath()).toEqual({ source: "threshold", state: BREATH_ENTRY, command: null });
    expect(parseManualBreath("/new")?.state).toBe(thresholdBreath().state);
    // 阈值硬闸的错误携带同一个统一触发：接住它的人不用自己再造。
    expect(new BreathThresholdError("w_x", 5, 3).trigger).toEqual(thresholdBreath());
  });

  it("大小写、空白与带参数的形式归一到同一入口；非命令原样放行", () => {
    expect(parseManualBreath("/Compact ")?.command).toBe("/compact");
    expect(parseManualBreath("/compact 保留最近 20 条")).toEqual({
      source: "manual",
      state: BREATH_ENTRY,
      command: "/compact",
    });
    // 参数怎么解释是状态机的事；「算不算换气」在这一层已定——命令后
    // 不带空格的粘连形不是命令，照常当发言。
    expect(parseManualBreath("/compactx")).toBeNull();
    expect(parseManualBreath("今晚聊聊 /compact 的好处")).toBeNull();
    expect(parseManualBreath("")).toBeNull();
  });

  it("真实输入路径（MistDriver.say）：命令被拦截成统一触发，不落树、不到模型", async () => {
    const driver = createDriver();
    const residentId = await driver.createResident("换气命令住户");

    for (const command of MANUAL_BREATH_COMMANDS) {
      await expect(driver.say(residentId, command)).rejects.toThrow(BreathCommandError);
      await expect(driver.say(residentId, command)).rejects.toMatchObject({
        code: BREATH_COMMAND,
        trigger: { source: "manual", state: BREATH_ENTRY, command },
      });
    }
    // 带参数的命令在输入路径上同样被拦截——没有 compact 旁路。
    await expect(driver.say(residentId, "/compact 保留最近 20 条")).rejects.toMatchObject({
      trigger: { command: "/compact" },
    });

    // 命令不是发言：树上一个节点都不该有。
    expect(await driver.history(residentId)).toHaveLength(0);

    // 普通发言不受影响，照常落两个节点。
    await driver.say(residentId, "一句普通的话");
    expect(await driver.history(residentId)).toHaveLength(2);
  });
});
