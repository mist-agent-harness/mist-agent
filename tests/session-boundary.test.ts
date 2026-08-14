/**
 * 会话边界的回归测试（#16 问 3 裁定）。
 *
 * 判卷 C1 验的是「杀会话不丢人」，这里守的是它背后那件更容易被写没的事：
 * 会话死这件事，必须在消息树上看得出来。
 *
 * 裁定原文的意思是 —— 不为判卷发明探针 API，会话边界是产品本来就该有的形状：
 * 同一会话内连续 say 挂在上一个回应下；kill 后第一次 say 必须是新根。
 * 少了这条，`killSession` 写成空函数照样能蒙混过关。
 */

import { describe, expect, it } from "vitest";
import { createDriver } from "../src/acceptance-driver.ts";

describe("会话边界", () => {
  it("同一会话内连续说话，后一句挂在前一句的回应下", async () => {
    const d = createDriver();
    const r = await d.createResident("r");
    const reply1 = await d.say(r, "第一句");
    await d.say(r, "第二句");
    const u2 = (await d.history(r)).find((n) => n.role === "user" && n.content === "第二句");
    expect(u2?.parentId).toBe(reply1.id);
  });

  it("kill 后第一次说话开新根", async () => {
    const d = createDriver();
    const r = await d.createResident("r");
    await d.say(r, "生前那句");
    await d.killSession(r);
    await d.say(r, "死后那句");
    const u = (await d.history(r)).find((n) => n.role === "user" && n.content === "死后那句");
    expect(u?.parentId).toBeNull();
  });

  it("kill 不动树——旧枝一个字节没少", async () => {
    const d = createDriver();
    const r = await d.createResident("r");
    await d.say(r, "留底的话");
    const before = JSON.stringify(await d.history(r));
    await d.killSession(r);
    expect(JSON.stringify(await d.history(r))).toBe(before);
  });

  it("kill 不动记忆和承诺——会话死，人不死", async () => {
    const d = createDriver();
    const r = await d.createResident("r");
    await d.remember(r, "记得的事");
    await d.commit(r, "答应过的事");
    await d.killSession(r);
    const pack = await d.buildBootPack(r);
    expect(pack.memories.map((m) => m.content)).toContain("记得的事");
    expect(pack.commitments).toContain("答应过的事");
  });

  it("连杀两次不炸，第二次是空操作", async () => {
    const d = createDriver();
    const r = await d.createResident("r");
    await d.say(r, "一句话");
    await d.killSession(r);
    const after = JSON.stringify(await d.history(r));
    await expect(d.killSession(r)).resolves.toBeUndefined();
    expect(JSON.stringify(await d.history(r))).toBe(after);
  });

  it("没说过话就 kill，之后第一句照样是新根", async () => {
    const d = createDriver();
    const r = await d.createResident("r");
    await d.killSession(r);
    await d.say(r, "开口第一句");
    const u = (await d.history(r)).find((n) => n.role === "user");
    expect(u?.parentId).toBeNull();
  });

  it("两个住户的会话互不干扰——杀 A 不打断 B 正说着的话", async () => {
    const d = createDriver();
    const [a, b] = [await d.createResident("a"), await d.createResident("b")];
    await d.say(a, "a 第一句");
    const bReply = await d.say(b, "b 第一句");
    await d.killSession(a);
    await d.say(b, "b 第二句");
    const u = (await d.history(b)).find((n) => n.role === "user" && n.content === "b 第二句");
    expect(u?.parentId).toBe(bReply.id);
  });

  it("启动包的承诺只认 commit 写入的原文，不认记忆里带『答应』的话", async () => {
    const d = createDriver();
    const r = await d.createResident("r");
    // 这条记忆里有「答应」二字，但它是一条记忆、不是一次承诺。
    // 旧实现按关键词从记忆里捞，会把它误当成承诺 —— 那是拿关键词匹配冒充承诺账本。
    await d.remember(r, "她说她答应过别人周末加班");
    await d.commit(r, "真正立下的那条");
    const pack = await d.buildBootPack(r);
    expect(pack.commitments).toEqual(["真正立下的那条"]);
  });
});
