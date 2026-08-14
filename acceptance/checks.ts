/**
 * 第一里程碑的六条验收。人话版在同目录 README.md，
 * 两边必须同步改；判卷以这里的代码为准。
 *
 * 判卷纪律：只做确定性断言（存储内容、hash、集合关系），
 * 不对模型输出的措辞做任何判断。
 */
import { createHash } from "node:crypto";
import type { AcceptanceCheck, BootPack, HarnessDriver, HistoryNode } from "./driver.ts";

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const c1: AcceptanceCheck = {
  id: "C1",
  title: "杀会话不丢人：会话真的死了，记忆和树一个字节没少",
  uses: [
    "createResident",
    "remember",
    "say",
    "history",
    "killSession",
    "buildBootPack",
    "destroyResident",
  ],
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c1-resident");
    const entryId = await driver.remember(r, "答应过：周五晚上一起看电影");
    const firstReply = await driver.say(r, "第一句");
    await driver.say(r, "第二句");
    // #16 问 3 裁定：同一会话内连续 say，后一个 user 节点挂在上一个回应节点下
    const treeBefore = await driver.history(r);
    const u2 = treeBefore.find((n) => n.role === "user" && n.content === "第二句");
    const continuity = u2 !== undefined && u2.parentId === firstReply.id;
    const treeHash = (nodes: readonly (typeof treeBefore)[number][]) =>
      sha256(JSON.stringify([...nodes].sort((a, b) => a.id.localeCompare(b.id))));
    const beforeHash = treeHash(treeBefore);
    await driver.killSession(r);
    // #16 补充：kill 本身不许动树——留底的树是住户态
    const treeIntact = treeHash(await driver.history(r)) === beforeHash;
    // #16 问 3 裁定：kill 后第一次 say 的 user 节点必须是新根（会话边界可判）
    await driver.say(r, "第三句");
    const treeAfter = await driver.history(r);
    const u3 = treeAfter.find((n) => n.role === "user" && n.content === "第三句");
    const boundary = u3 !== undefined && u3.parentId === null;
    const pack = await driver.buildBootPack(r);
    const carried = pack.memories.some((m) => m.id === entryId);
    await driver.destroyResident(r);
    const pass = continuity && treeIntact && boundary && carried;
    return {
      pass,
      detail: pass
        ? "会话连续性成立；kill 未动树；kill 后新 say 开新根；生前记忆在新启动包里"
        : `continuity=${continuity} treeIntact=${treeIntact} boundary=${boundary} carried=${carried}`,
    };
  },
};

const c2: AcceptanceCheck = {
  id: "C2",
  title: "凭启动包醒来：包里有我是谁和我答应过什么",
  uses: ["createResident", "remember", "commit", "buildBootPack", "destroyResident"],
  async run(driver: HarnessDriver) {
    const promise = "答应过：每晚 23:30 前熄灯";
    const r = await driver.createResident("c2-resident");
    await driver.remember(r, "身份：测试住户小二");
    // #16 问 4 裁定：承诺必须真实写入、真实进包，恒返空数组判不过
    await driver.commit(r, promise);
    const pack = await driver.buildBootPack(r);
    const hasIdentity = pack.identity.length > 0;
    const hasCommitment = pack.commitments.includes(promise);
    await driver.destroyResident(r);
    const pass = pack.residentId === r && hasIdentity && hasCommitment;
    return {
      pass,
      detail: pass
        ? "启动包由存储生成，身份在场，写入的承诺原文在包里"
        : `启动包缺件：identity=${hasIdentity} commitment=${hasCommitment}`,
    };
  },
};

const c3: AcceptanceCheck = {
  id: "C3",
  title: "不改史：改口只长新枝，旧枝一个字节不动",
  uses: ["createResident", "say", "history", "reviseNode", "destroyResident"],
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c3-resident");
    const reply = await driver.say(r, "第一版说法");
    // #14 裁定：say 落 user + assistant 两个节点，返回的是 assistant 节点，
    // 且 assistant 节点挂在 user 节点下面
    const afterSay = await driver.history(r);
    const userNode = afterSay.find((n) => n.role === "user" && n.content === "第一版说法");
    const sayShape =
      reply.role === "assistant" && userNode !== undefined && reply.parentId === userNode.id;
    const originalHash = sha256(JSON.stringify([reply.id, reply.content, reply.createdAt]));
    const revised = await driver.reviseNode(r, reply.id, "改口后的说法");
    const tree = await driver.history(r);
    const old = tree.find((n) => n.id === reply.id);
    const oldIntact =
      old !== undefined &&
      sha256(JSON.stringify([old.id, old.content, old.createdAt])) === originalHash;
    // #14 裁定：改口是同父分叉，新节点与旧节点是兄弟不是子嗣
    const forked =
      revised.id !== reply.id &&
      revised.parentId === reply.parentId &&
      tree.some((n) => n.id === revised.id);
    // #14 裁定：拿别的住户的 nodeId 来改必须拒绝
    const stranger = await driver.createResident("c3-stranger");
    let crossRejected = false;
    try {
      await driver.reviseNode(stranger, reply.id, "越权改口");
    } catch {
      crossRejected = true;
    }
    await driver.destroyResident(stranger);
    await driver.destroyResident(r);
    const pass = sayShape && oldIntact && forked && crossRejected;
    return {
      pass,
      detail: pass
        ? "say 双节点成形；旧节点 hash 不变；改口同父分叉；跨房改口被拒"
        : `sayShape=${sayShape} oldIntact=${oldIntact} forked=${forked} crossRejected=${crossRejected}`,
    };
  },
};

const c4: AcceptanceCheck = {
  id: "C4",
  title: "勘误留底：错的标记被取代但留在原地，新旧链得上",
  uses: ["createResident", "remember", "errata", "recall", "destroyResident"],
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
  uses: ["createResident", "remember", "buildBootPack", "recall", "destroyResident"],
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
  title: "迁移可回滚：启动包与消息树都逐字节等价，原件不动",
  uses: [
    "createResident",
    "remember",
    "errata",
    "say",
    "buildBootPack",
    "history",
    "exportResident",
    "importResident",
    "destroyResident",
  ],
  async run(driver: HarnessDriver) {
    const r = await driver.createResident("c6-resident");
    await driver.remember(r, "迁移前的记忆一号");
    // 正文故意包含源 residentId：结构化归一不许碰它
    const wrongId = await driver.remember(r, `迁移前的记忆二号，正文提到 ${r}`);
    await driver.errata(r, wrongId, "勘误后的记忆二号");
    await driver.say(r, "迁移前说过的话");
    const packBefore = await driver.buildBootPack(r);
    const treeBefore = await driver.history(r);
    const exported = await driver.exportResident(r);
    const r2 = await driver.importResident(exported);
    const packAfter = await driver.buildBootPack(r2);
    const treeAfter = await driver.history(r2);
    // #16 问 5：结构化归一——只替换 residentId 字段，不碰 content 正文
    const canonicalPack = (p: BootPack) =>
      JSON.stringify({
        ...p,
        residentId: "RESIDENT",
        memories: p.memories.map((m) => ({ ...m, residentId: "RESIDENT" })),
      });
    const canonicalTree = (nodes: readonly HistoryNode[]) =>
      JSON.stringify([...nodes].sort((a, b) => a.id.localeCompare(b.id)));
    const packIdentical = canonicalPack(packBefore) === canonicalPack(packAfter);
    // #16 二轮裁定 A：留底的树也是住户态，迁移丢树判不过
    const treeIdentical = canonicalTree(treeBefore) === canonicalTree(treeAfter);
    // 销毁导入件后复查原件——回滚的最低含义是导入件的生死不牵连原件
    await driver.destroyResident(r2);
    const originalIntact =
      canonicalPack(await driver.buildBootPack(r)) === canonicalPack(packBefore) &&
      canonicalTree(await driver.history(r)) === canonicalTree(treeBefore);
    await driver.destroyResident(r);
    const pass = packIdentical && treeIdentical && originalIntact;
    return {
      pass,
      detail: pass
        ? "启动包与消息树均等价，销毁导入件后原件完好"
        : `packIdentical=${packIdentical} treeIdentical=${treeIdentical} originalIntact=${originalIntact}`,
    };
  },
};

export const checks: AcceptanceCheck[] = [c1, c2, c3, c4, c5, c6];
