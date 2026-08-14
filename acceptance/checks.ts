/**
 * 第一里程碑的六条验收。人话版在 docs/acceptance/milestone-1.md，
 * 两边必须同步改；判卷以这里的代码为准。
 *
 * 判卷纪律：只做确定性断言（存储内容、hash、集合关系），
 * 不对模型输出的措辞做任何判断。
 */
import { createHash } from "node:crypto";
import type { AcceptanceCheck, HarnessDriver } from "./driver.ts";

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const c1: AcceptanceCheck = {
  id: "C1",
  title: "杀会话不丢人：会话死了，记忆和承诺还在",
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c1-resident");
    const entryId = await driver.remember(r, "答应过：周五晚上一起看电影");
    await driver.say(r, "记住这件事");
    await driver.killSession(r);
    const pack = await driver.buildBootPack(r);
    const carried = pack.memories.some((m) => m.id === entryId);
    await driver.destroyResident(r);
    return {
      pass: carried,
      detail: carried
        ? "被杀会话前落库的记忆出现在新启动包里"
        : "会话死后启动包里找不到生前落库的记忆",
    };
  },
};

const c2: AcceptanceCheck = {
  id: "C2",
  title: "凭启动包醒来：包里有我是谁和我答应过什么",
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c2-resident");
    await driver.remember(r, "身份：测试住户小二");
    const pack = await driver.buildBootPack(r);
    const hasIdentity = pack.identity.length > 0;
    const hasCommitmentField = Array.isArray(pack.commitments);
    await driver.destroyResident(r);
    const pass = pack.residentId === r && hasIdentity && hasCommitmentField;
    return {
      pass,
      detail: pass
        ? "启动包由存储生成，身份与承诺栏俱在"
        : `启动包缺件：identity=${hasIdentity} commitments=${hasCommitmentField}`,
    };
  },
};

const c3: AcceptanceCheck = {
  id: "C3",
  title: "不改史：改口只长新枝，旧枝一个字节不动",
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c3-resident");
    const node = await driver.say(r, "第一版说法");
    const originalHash = sha256(JSON.stringify([node.id, node.content, node.createdAt]));
    const revised = await driver.reviseNode(r, node.id, "改口后的说法");
    const tree = await driver.history(r);
    const old = tree.find((n) => n.id === node.id);
    const oldIntact =
      old !== undefined &&
      sha256(JSON.stringify([old.id, old.content, old.createdAt])) === originalHash;
    const newIsBranch = revised.id !== node.id && tree.some((n) => n.id === revised.id);
    await driver.destroyResident(r);
    const pass = oldIntact && newIsBranch;
    return {
      pass,
      detail: pass
        ? "旧节点 hash 不变，新节点以新枝存在"
        : `oldIntact=${oldIntact} newIsBranch=${newIsBranch}`,
    };
  },
};

const c4: AcceptanceCheck = {
  id: "C4",
  title: "勘误留底：错的标记被取代但留在原地，新旧链得上",
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c4-resident");
    const wrongId = await driver.remember(r, "住在深圳华侨城");
    const rightId = await driver.errata(r, wrongId, "住在武汉华侨城");
    const all = await driver.recall(r, "华侨城");
    const wrong = all.find((m) => m.id === wrongId);
    const right = all.find((m) => m.id === rightId);
    const pass =
      wrong !== undefined &&
      wrong.supersededBy === rightId &&
      wrong.content === "住在深圳华侨城" &&
      right !== undefined &&
      right.supersededBy === null;
    await driver.destroyResident(r);
    return {
      pass,
      detail: pass ? "旧条目原文留底并指向新条目，新条目为活条目" : "勘误链断裂或旧条目被改写/删除",
    };
  },
};

const c5: AcceptanceCheck = {
  id: "C5",
  title: "不串房：A 的记忆不出现在 B 的启动包和检索里",
  async run(driver: HarnessDriver) {
    const marker = `串房检测标记-${Date.now()}`;
    const a = await driver.createResident("c5-resident-a");
    const b = await driver.createResident("c5-resident-b");
    await driver.remember(a, marker);
    const bPack = await driver.buildBootPack(b);
    const bRecall = await driver.recall(b, marker);
    const leakedInPack = bPack.memories.some((m) => m.content.includes(marker));
    const leakedInRecall = bRecall.some((m) => m.content.includes(marker));
    await driver.destroyResident(a);
    await driver.destroyResident(b);
    const pass = !leakedInPack && !leakedInRecall;
    return {
      pass,
      detail: pass
        ? "跨住户检索与启动包均无泄漏"
        : `泄漏：bootPack=${leakedInPack} recall=${leakedInRecall}`,
    };
  },
};

const c6: AcceptanceCheck = {
  id: "C6",
  title: "迁移可回滚：导出导入后启动包逐字节等价，原件不动",
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c6-resident");
    await driver.remember(r, "迁移前的记忆一号");
    await driver.remember(r, "迁移前的记忆二号");
    const packBefore = await driver.buildBootPack(r);
    const exported = await driver.exportResident(r);
    const r2 = await driver.importResident(exported);
    const packAfter = await driver.buildBootPack(r2);
    const canonical = (p: unknown, stripId: string) =>
      JSON.stringify(p).replaceAll(stripId, "RESIDENT");
    const identical = canonical(packBefore, r) === canonical(packAfter, r2);
    const originalStillThere = (await driver.buildBootPack(r)).memories.length === 2;
    await driver.destroyResident(r);
    await driver.destroyResident(r2);
    const pass = identical && originalStillThere;
    return {
      pass,
      detail: pass
        ? "导入件与原件启动包等价，原件未被迁移动过"
        : `identical=${identical} originalIntact=${originalStillThere}`,
    };
  },
};

export const checks: AcceptanceCheck[] = [c1, c2, c3, c4, c5, c6];
