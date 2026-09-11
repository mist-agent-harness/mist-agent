/**
 * 有意隔离 v0 · 线 2（膜）的判卷，第一批。
 *
 * 人话版在 `acceptance/intentional-isolation-v0.md`，两边必须同步改；**判卷以这里为准**。
 *
 * 本批只覆盖不依赖线 1 认证来源接缝的七条：
 * II-C01、II-C02、II-C03、II-C05、II-D06、II-D07、II-D08。
 * 其余条目等 #163 的公开接缝落地后另交。
 *
 * 判卷纪律：只做确定性断言（存储内容、字节相等、集合关系），不判模型说话的措辞。
 * **凡否定断言必先跑正对照**——见 `requireNonEmpty`。
 */
import {
  type IsolationCheck,
  type IsolationCheckResult,
  type IsolationDriver,
  requireNonEmpty,
} from "./isolation-driver.ts";

const pass = (detail: string): IsolationCheckResult => ({ passed: true, detail });
const fail = (detail: string): IsolationCheckResult => ({ passed: false, detail });

/** 名单是一份显式清单，不是相似度查询的返回值。 */
const c01: IsolationCheck = {
  id: "II-C01",
  title: "default-in 名单是显式清单：可枚举、无 query 参数、同一住户两次调用集合相等",
  uses: ["createResident", "addDefaultIn", "listDefaultIn", "destroyResident"],
  async run(driver: IsolationDriver) {
    const r = await driver.createResident("c01");
    try {
      const listed = "她说话偏好短句，不用破折号";
      await driver.addDefaultIn(r, {
        content: listed,
        origin: { kind: "verified", ref: "confirm:2026-09-02" },
      });
      const first = await driver.listDefaultIn(r);
      const guard = requireNonEmpty(first, "default-in 名单");
      if (!guard.ok) return fail(guard.detail);
      if (!guard.items.some((x) => x.content === listed)) {
        return fail("刚写入的条目不在名单里——名单非空但装的不是我写进去的东西");
      }

      const second = await driver.listDefaultIn(r);
      if (!second.ok) return fail(`第二次列名单失败：${second.reason}`);

      const ids = (xs: { id: string }[]) => [...xs.map((x) => x.id)].sort().join(",");
      if (ids(guard.items) !== ids(second.items)) {
        return fail("同一住户连续两次 listDefaultIn 返回的集合不相等——名单像是查询结果而不是清单");
      }
      // 接口层判据：listDefaultIn 只接一个参数。多出来的参数即为 query 入口。
      if (driver.listDefaultIn.length !== 1) {
        return fail(
          `listDefaultIn 接受 ${driver.listDefaultIn.length} 个参数——名单不许有 query 入口`,
        );
      }
      return pass(`名单可枚举且两次调用一致（${guard.items.length} 条），无 query 参数`);
    } finally {
      await driver.destroyResident(r);
    }
  },
};

/** 缺 origin 的条目不许进名单。 */
const c02: IsolationCheck = {
  id: "II-C02",
  title: "名单每条带来源：缺 origin 的条目写入被拒",
  uses: ["createResident", "addDefaultIn", "listDefaultIn", "destroyResident"],
  async run(driver: IsolationDriver) {
    const r = await driver.createResident("c02");
    try {
      // 正对照：合法写入必须先成功。否则「两次都被拒」可能只是 addDefaultIn 一律抛错。
      const legit = "她的辣度：两档，湖南口味";
      await driver.addDefaultIn(r, {
        content: legit,
        origin: { kind: "verified", ref: "confirm:2026-07-27" },
      });
      const control = await driver.listDefaultIn(r);
      const controlGuard = requireNonEmpty(control, "合法写入后的 default-in 名单");
      if (!controlGuard.ok) return fail(controlGuard.detail);
      if (!controlGuard.items.some((x) => x.content === legit)) {
        return fail("正对照失败：带 origin 的合法条目没能写进名单——无法据此断言拒绝是真拒绝");
      }

      let rejectedUnknown = false;
      try {
        await driver.addDefaultIn(r, {
          content: "来路不明的偏好",
          origin: { kind: "unknown", ref: null },
        });
      } catch {
        rejectedUnknown = true;
      }
      if (!rejectedUnknown) return fail("origin.kind=unknown 的条目被接受了——名单每条必须带来源");

      let rejectedNullRef = false;
      try {
        await driver.addDefaultIn(r, {
          content: "自称已确认但指不出出处",
          origin: { kind: "verified", ref: null },
        });
      } catch {
        rejectedNullRef = true;
      }
      if (!rejectedNullRef) {
        return fail("origin.kind=verified 但 ref 为空的条目被接受了——verified 必须指得出出处");
      }

      const after = await driver.listDefaultIn(r);
      if (!after.ok) return fail(`列名单失败：${after.reason}`);
      const contents = after.items.map((x) => x.content);
      if (contents.length !== 1 || contents[0] !== legit) {
        return fail(
          `两次被拒的写入之后名单应当只剩正对照那一条，实际是 ${JSON.stringify(contents)}——拒绝没有真的拒绝`,
        );
      }
      return pass(
        "合法写入成功（正对照成立），unknown 与 ref 为空两种缺来源写入均被拒，名单未被污染",
      );
    } finally {
      await driver.destroyResident(r);
    }
  },
};

/** 缺 origin 的 legacy 不进名单——**先跑正对照**。 */
const c03: IsolationCheck = {
  id: "II-C03",
  title: "缺 origin 的 legacy 不进自动进入内容（先证明名单内条目确实进来了）",
  uses: [
    "createResident",
    "createScope",
    "addDefaultIn",
    "seedLegacyMemory",
    "assembleContext",
    "listDefaultIn",
    "destroyResident",
  ],
  async run(driver: IsolationDriver) {
    const r = await driver.createResident("c03");
    try {
      const canary = `legacy-canary-${Date.now().toString(36)}`;
      const listed = "她的语言偏好：中文口语，不写公文腔";
      await driver.addDefaultIn(r, {
        content: listed,
        origin: { kind: "verified", ref: "confirm:2026-08-16" },
      });
      await driver.seedLegacyMemory(r, canary);

      const scope = await driver.createScope(r, "c03-scope");
      const ctx = await driver.assembleContext(r, scope);

      // 正对照：名单内那条必须真的在，否则「canary 不在」毫无意义
      const guard = requireNonEmpty(ctx, "新 scope 的开工上下文");
      if (!guard.ok) return fail(guard.detail);
      if (!guard.items.some((x) => x.includes(listed))) {
        return fail("正对照失败：名单内条目没有出现在新 scope 的上下文里——装配路径不可信");
      }

      if (guard.items.some((x) => x.includes(canary))) {
        return fail("缺 origin 的 legacy 记忆出现在了自动进入内容里");
      }

      // 灯题是「不进自动进入内容」，名单是它的上游：canary 也不许混进名单本身。
      const list = await driver.listDefaultIn(r);
      if (!list.ok) return fail(`列名单失败：${list.reason}`);
      if (list.items.some((x) => x.content.includes(canary))) {
        return fail("缺 origin 的 legacy 记忆被收进了 default-in 名单");
      }
      return pass("名单内条目已进（正对照成立），legacy canary 既不在名单里也不在上下文里");
    } finally {
      await driver.destroyResident(r);
    }
  },
};

/** 名单外默认不进——**先跑正对照**。 */
const c05: IsolationCheck = {
  id: "II-C05",
  title: "名单外的住户级内容默认不进新 scope（先证明名单内条目确实进来了）",
  uses: [
    "createResident",
    "createScope",
    "addDefaultIn",
    "remember",
    "assembleContext",
    "destroyResident",
  ],
  async run(driver: IsolationDriver) {
    const r = await driver.createResident("c05");
    try {
      const canary = `offlist-canary-${Date.now().toString(36)}`;
      const listed = "她的辣度：两档，湖南口味";
      await driver.addDefaultIn(r, {
        content: listed,
        origin: { kind: "verified", ref: "confirm:2026-07-27" },
      });
      await driver.remember(r, canary);

      const scope = await driver.createScope(r, "c05-scope");
      const ctx = await driver.assembleContext(r, scope);

      const guard = requireNonEmpty(ctx, "新 scope 的开工上下文");
      if (!guard.ok) return fail(guard.detail);
      if (!guard.items.some((x) => x.includes(listed))) {
        return fail("正对照失败：名单内条目没有进上下文——无法据此断言名单外的没进");
      }

      if (guard.items.some((x) => x.includes(canary))) {
        return fail("名单外的住户级记忆进了新 scope 的上下文");
      }
      return pass("名单内已进（正对照成立），名单外 canary 未进");
    } finally {
      await driver.destroyResident(r);
    }
  },
};

/** 更正走加注/勘误链，不走就地覆盖。 */
const d06: IsolationCheck = {
  id: "II-D06",
  title: "更正只追加勘误链：旧条目字节不变，新条目链回旧条目",
  uses: ["createResident", "remember", "errata", "readEntry", "destroyResident"],
  async run(driver: IsolationDriver) {
    const r = await driver.createResident("d06");
    try {
      const original = "居酒屋在 Surry Hills";
      const oldId = await driver.remember(r, original);
      const before = await driver.readEntry(r, oldId);

      const newId = await driver.errata(r, oldId, "居酒屋在 Chippendale，不是 Surry Hills");
      const after = await driver.readEntry(r, oldId);

      if (after.entry.content !== before.entry.content) {
        return fail(
          `旧条目正文被改写了：「${before.entry.content}」→「${after.entry.content}」——更正不许就地覆盖`,
        );
      }
      if (after.entry.content !== original) {
        return fail("旧条目正文与写入时不一致");
      }
      if (after.entry.supersededBy !== newId) {
        return fail(
          `旧条目的 supersededBy 是 ${String(after.entry.supersededBy)}，应指向新条目 ${newId}`,
        );
      }
      const fresh = await driver.readEntry(r, newId);
      if (fresh.entry.supersededBy !== null) {
        return fail("新条目一出生就被标为已取代");
      }
      return pass("旧条目原文字节不变且 supersededBy 指向新条目，新条目为活条目");
    } finally {
      await driver.destroyResident(r);
    }
  },
};

/** 加注的可发现性由读取路径保证。 */
const d07: IsolationCheck = {
  id: "II-D07",
  title: "加注在读取路径上：只读正文也必然拿到加注",
  uses: ["createResident", "remember", "annotate", "readEntry", "destroyResident"],
  async run(driver: IsolationDriver) {
    const r = await driver.createResident("d07");
    try {
      const entryId = await driver.remember(r, "她说周五要交 A1b");
      const noteId = await driver.annotate(r, entryId, "更正：A1b 是 10-12 周一，不是周五");

      const read = await driver.readEntry(r, entryId);
      if (read.annotations.length === 0) {
        return fail("读正文时没有一并返回加注——躺在库里但不在故障现场读取路径上的更正，等于没有");
      }
      if (!read.annotations.some((a) => a.id === noteId)) {
        return fail(`读回的加注里没有刚写的那条（${noteId}）`);
      }
      if (read.entry.content !== "她说周五要交 A1b") {
        return fail("加注改动了正文——加注是改写的逆操作，不是另一种改写");
      }
      return pass("加注随正文一并返回，且正文未被改动");
    } finally {
      await driver.destroyResident(r);
    }
  },
};

/** 不可逆删除留一块不泄密的疤。 */
const d08: IsolationCheck = {
  id: "II-D08",
  title: "删除留疤：原值不可恢复，疤可见且不泄露被删内容",
  uses: [
    "createResident",
    "remember",
    "hardDelete",
    "listMemories",
    "readEntry",
    "destroyResident",
  ],
  async run(driver: IsolationDriver) {
    const r = await driver.createResident("d08");
    try {
      const secret = `deleted-secret-${Date.now().toString(36)}`;
      const entryId = await driver.remember(r, secret);

      const before = await driver.listMemories(r);
      const guard = requireNonEmpty(before, "删除前的住户级记忆");
      if (!guard.ok) return fail(guard.detail);
      if (!guard.items.some((m) => m.content.includes(secret))) {
        return fail("正对照失败：删除前就查不到那条记忆，无法证明删除做了什么");
      }

      await driver.hardDelete(r, entryId, "她要求彻底删掉");

      const after = await driver.listMemories(r);
      if (!after.ok) return fail(`删除后列记忆失败：${after.reason}`);

      const survivor = after.items.find((m) => m.id === entryId);
      if (survivor === undefined) {
        return fail("删除后条目整个消失了——不可逆删除仍须留下变更疤");
      }
      if (survivor.tombstone === undefined) {
        return fail("条目还在但没有 tombstone——疤必须可见");
      }
      if (JSON.stringify(after.items).includes(secret)) {
        return fail("列表路径的疤或残留数据里仍能读到被删内容——原值必须不可恢复");
      }

      // 「不可恢复」是对所有读口说的。只扫 listMemories 会漏掉 readEntry 这条路。
      try {
        const direct = await driver.readEntry(r, entryId);
        if (JSON.stringify(direct).includes(secret)) {
          return fail("readEntry 仍能读回被删内容——列表路径干净不等于原值不可恢复");
        }
      } catch {
        // 直接读被删条目抛错也是合法实现：原值同样取不回来。
      }
      return pass("两条读口（listMemories / readEntry）均取不回原值，疤可见且不泄露被删内容");
    } finally {
      await driver.destroyResident(r);
    }
  },
};

export const isolationChecks: IsolationCheck[] = [c01, c02, c03, c05, d06, d07, d08];
