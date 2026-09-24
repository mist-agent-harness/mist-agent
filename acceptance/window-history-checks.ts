/**
 * #120 WH-01～WH-06 的六盏可执行判卷。
 *
 * 清单真源：`acceptance/window-history.md`。两边必须同步改，判卷以代码为准。
 *
 * 判卷纪律（照 acceptance/README.md）：只做确定性断言——比字节、比序号、比内容
 * hash、比结构化错误与真实副作用；不判「看起来像有历史」。每盏灯都带正对照：
 * 先证明被判的行为确实有机会发生，再证明它没有被偷懒实现糊过去，否则断言空转
 * 也能点绿。
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppendReceipt,
  DurableSnapshot,
  HostDescriptor,
  JsonValue,
  Result,
  WindowHistoryCheck,
  WindowHistoryCheckResult,
  WindowHistoryDriver,
  WindowHistoryEntry,
  WindowHistoryError,
  WindowHistoryPage,
  WindowHistoryPageRequest,
  WindowHistoryRef,
} from "./window-history-driver.ts";
import { auditWindowHistoryWriteSurface } from "./window-history-write-surface.ts";

const pass = (detail: string): WindowHistoryCheckResult => ({ passed: true, detail });
const fail = (detail: string): WindowHistoryCheckResult => ({ passed: false, detail });

/** 判卷内部的断言失败：由每盏灯自己收敛成红灯理由，不冒充驱动抛错。 */
class CheckFailure extends Error {}

function fatal(detail: string): never {
  throw new CheckFailure(detail);
}

const FULL_PAGE: WindowHistoryPageRequest = { beforeSeq: null, maxMessages: null };

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key] ?? null)}`)
    .join(",")}}`;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * 一条历史的可比指纹。
 *
 * 同时盖 payload 的内容 hash 与底座发的 `payloadHash`：只比后者会让一个把 payload
 * 丢空、只留 hash 字段的实现点绿。
 */
function fingerprint(entry: WindowHistoryEntry): string {
  return stableJson({
    eventId: entry.eventId,
    streamSeq: entry.streamSeq,
    generation: entry.generation,
    payloadHash: entry.payloadHash,
    payloadContentHash: sha256(stableJson(entry.payload)),
  });
}

/** 迁移会合法改写 `formatVersion`，所以格式无关的指纹另给一支。 */
function pageFingerprints(page: WindowHistoryPage): string[] {
  return page.entries.map(fingerprint);
}

function pageShape(page: WindowHistoryPage): string {
  return stableJson({
    windowId: page.windowId,
    hasMore: page.hasMore,
    damaged: page.damaged.map((report) => ({
      streamSeq: report.streamSeq,
      reason: report.reason,
    })),
    entries: page.entries.map((entry) => ({
      fingerprint: fingerprint(entry),
      formatVersion: entry.formatVersion,
    })),
  });
}

function expectOk<T>(result: Result<T>, what: string): T {
  if (!result.ok) {
    fatal(`${what} 本该成功却报错：${result.error.code}（${result.error.message}）`);
  }
  return result.value;
}

function expectFailClosed<T>(
  result: Result<T>,
  what: string,
): asserts result is { readonly ok: false; readonly error: WindowHistoryError } {
  if (result.ok) {
    fatal(`${what} 本该 fail-closed，却返回了正常结果`);
  }
  if (result.error.message.length === 0) {
    fatal(`${what} 的结构化错误没有 message，调用方拿不到判据`);
  }
}

function requireAt<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) fatal(`${what} 缺第 ${index + 1} 项（实到 ${items.length} 项）`);
  return item;
}

function markOf(entry: WindowHistoryEntry): string | null {
  const mark = entry.payload.mark;
  return typeof mark === "string" ? mark : null;
}

function marksOf(page: WindowHistoryPage): string[] {
  return page.entries.map((entry) => markOf(entry) ?? `<无 mark:${entry.eventId}>`);
}

function assertAscending(page: WindowHistoryPage, what: string): void {
  let previous = 0;
  for (const entry of page.entries) {
    if (entry.streamSeq <= previous) {
      fatal(`${what} 的 streamSeq 不是严格升序：${page.entries.map((e) => e.streamSeq).join(",")}`);
    }
    previous = entry.streamSeq;
  }
}

function assertSameEntries(
  before: WindowHistoryPage,
  after: WindowHistoryPage,
  what: string,
): void {
  const left = pageFingerprints(before);
  const right = pageFingerprints(after);
  if (left.length !== right.length) {
    fatal(`${what} 条目数变了：前 ${left.length} 条，后 ${right.length} 条`);
  }
  for (const [index, expected] of left.entries()) {
    if (right[index] !== expected) {
      fatal(`${what} 第 ${index + 1} 条不等价：\n  前 ${expected}\n  后 ${right[index]}`);
    }
  }
}

/** 真实落盘证据：数内容字节。目录不存在或为空都返回 0。 */
function durableByteCount(dataDir: string): number {
  let total = 0;
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else total += stats.size;
    }
  };
  walk(dataDir);
  return total;
}

function snapshotShape(snapshot: DurableSnapshot): string {
  return stableJson(
    [...snapshot.records]
      .map((record) => ({
        relativePath: record.relativePath,
        byteHash: record.byteHash,
        byteLength: record.byteLength,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  );
}

async function bootHost(driver: WindowHistoryDriver, what: string): Promise<HostDescriptor> {
  const host = await driver.startHost();
  if (!Number.isInteger(host.pid) || host.pid <= 0) fatal(`${what} 没有报出真实进程 pid`);
  if (host.bootId.length === 0) fatal(`${what} 没有报出 bootId，无法判断是否换了进程`);
  if (host.dataDir.length === 0) fatal(`${what} 没有报出落盘根目录`);
  return host;
}

interface SeededWindow {
  readonly ref: WindowHistoryRef;
  readonly receipts: readonly AppendReceipt[];
}

/** 造被读的事实：开窗 + 按序写 n 条事件，全部经底座唯一写方。 */
async function seedWindow(
  driver: WindowHistoryDriver,
  input: {
    residentId: string;
    windowId: string;
    generation: number;
    prefix: string;
    count: number;
  },
): Promise<SeededWindow> {
  const opened = expectOk(
    await driver.openWindow({ residentId: input.residentId, windowId: input.windowId }),
    `开窗 ${input.windowId}`,
  );
  if (opened.windowId !== input.windowId) {
    fatal(`开窗返回的 windowId 与请求不一致：请求 ${input.windowId}，实到 ${opened.windowId}`);
  }
  const receipts: AppendReceipt[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const receipt = expectOk(
      await driver.appendWindowEvent({
        residentId: input.residentId,
        windowId: input.windowId,
        generation: input.generation,
        idempotencyKey: `${input.prefix}-${index}`,
        payload: { mark: `${input.prefix}-${index}` },
      }),
      `向 ${input.windowId} 写第 ${index + 1} 条`,
    );
    receipts.push(receipt);
  }
  return {
    ref: { residentId: input.residentId, windowId: input.windowId, generation: null },
    receipts,
  };
}

function checkBody(
  body: (driver: WindowHistoryDriver) => Promise<WindowHistoryCheckResult>,
): (driver: WindowHistoryDriver) => Promise<WindowHistoryCheckResult> {
  return async (driver) => {
    try {
      return await body(driver);
    } catch (error) {
      if (error instanceof CheckFailure) return fail(error.message);
      throw error;
    } finally {
      await driver.reset();
    }
  };
}

const wh01: WindowHistoryCheck = {
  id: "WH-01",
  title: "跨进程重启可读",
  uses: ["startHost", "killHost", "openWindow", "appendWindowEvent", "read", "summarize", "reset"],
  run: checkBody(async (driver) => {
    const first = await bootHost(driver, "首次启动的宿主");
    const seeded = await seedWindow(driver, {
      residentId: "wh01-resident",
      windowId: "wh01-window",
      generation: 1,
      prefix: "wh01",
      count: 5,
    });

    const before = expectOk(await driver.read(seeded.ref, FULL_PAGE), "死前整窗读");
    if (before.entries.length !== 5) {
      fatal(`死前整窗应有 5 条，实到 ${before.entries.length} 条——正对照不成立，后面的比较是空转`);
    }
    assertAscending(before, "死前整窗页");
    if (before.damaged.length !== 0) fatal("健康窗的 damaged 不该非空");
    if (before.hasMore) fatal("整窗读不该报 hasMore");
    const expectedMarks = ["wh01-0", "wh01-1", "wh01-2", "wh01-3", "wh01-4"];
    if (stableJson(marksOf(before)) !== stableJson(expectedMarks)) {
      fatal(`死前 payload 顺序不对：${marksOf(before).join(",")}`);
    }

    const pagedRequest: WindowHistoryPageRequest = {
      beforeSeq: requireAt(seeded.receipts, 4, "写入收据").streamSeq,
      maxMessages: 2,
    };
    const pagedBefore = expectOk(await driver.read(seeded.ref, pagedRequest), "死前分页读");
    if (pagedBefore.entries.length !== 2) {
      fatal(`死前分页应回 2 条，实到 ${pagedBefore.entries.length} 条——分页语义没生效`);
    }
    if (!pagedBefore.hasMore) fatal("死前分页丢了头部条目却没报 hasMore");
    const summaryBefore = expectOk(await driver.summarize(seeded.ref), "死前 summarize");
    if (summaryBefore.blank) fatal("写过 5 条的窗被 summarize 报成 blank");

    const bytesBefore = durableByteCount(first.dataDir);
    if (bytesBefore === 0) {
      fatal(`落盘根目录 ${first.dataDir} 里一个字节都没有：这是内存替身，不是持久化，按清单判红`);
    }

    await driver.killHost();
    const second = await bootHost(driver, "重启后的宿主");
    if (second.bootId === first.bootId) {
      fatal("重启后 bootId 没变：宿主没有真的换进程，只在单进程内存里成立的实现判红");
    }
    if (second.pid === first.pid) fatal("重启后 pid 没变：宿主进程没有真的被杀掉重起");
    if (second.dataDir !== first.dataDir) {
      fatal(`重启换了落盘根目录（${first.dataDir} → ${second.dataDir}）：读回的不是死前那份数据`);
    }

    const after = expectOk(await driver.read(seeded.ref, FULL_PAGE), "重启后整窗读");
    if (after.entries.length === 0) {
      fatal("重启后整窗读回空页——历史活在内存里，杀了就没了");
    }
    assertSameEntries(before, after, "重启前后整窗历史");
    assertAscending(after, "重启后整窗页");

    const pagedAfter = expectOk(await driver.read(seeded.ref, pagedRequest), "重启后分页读");
    if (pageShape(pagedAfter) !== pageShape(pagedBefore)) {
      fatal(
        `分页语义重启前后不一致：\n  前 ${pageShape(pagedBefore)}\n  后 ${pageShape(pagedAfter)}`,
      );
    }
    const summaryAfter = expectOk(await driver.summarize(seeded.ref), "重启后 summarize");
    if (summaryAfter.blank) fatal("重启后 summarize 把有历史的窗报成 blank");
    if (summaryAfter.updatedAt !== summaryBefore.updatedAt) {
      fatal(
        `重启后 updatedAt 漂了（${summaryBefore.updatedAt} → ${summaryAfter.updatedAt}）：摘要不是从落盘事实派生的`,
      );
    }

    return pass(
      `5 条事件跨真实进程重启（pid ${first.pid}→${second.pid}，落盘 ${bytesBefore} 字节）逐项等价，分页语义前后一致`,
    );
  }),
};

const wh02: WindowHistoryCheck = {
  id: "WH-02",
  title: "并发按窗隔离，冲突有判据",
  uses: [
    "startHost",
    "openWindow",
    "appendWindowEvent",
    "appendWindowEventsConcurrently",
    "rotateGeneration",
    "writerIdentity",
    "read",
    "reset",
  ],
  run: checkBody(async (driver) => {
    await bootHost(driver, "宿主");
    const residentId = "wh02-resident";
    const windowA = "wh02-window-a";
    const windowB = "wh02-window-b";
    const refA: WindowHistoryRef = { residentId, windowId: windowA, generation: null };
    const refB: WindowHistoryRef = { residentId, windowId: windowB, generation: null };
    expectOk(await driver.openWindow({ residentId, windowId: windowA }), "开窗 A");
    expectOk(await driver.openWindow({ residentId, windowId: windowB }), "开窗 B");

    const concurrent = await driver.appendWindowEventsConcurrently([
      {
        residentId,
        windowId: windowA,
        generation: 1,
        idempotencyKey: "wh02-a-1",
        payload: { mark: "wh02-a-1" },
      },
      {
        residentId,
        windowId: windowA,
        generation: 1,
        idempotencyKey: "wh02-a-2",
        payload: { mark: "wh02-a-2" },
      },
    ]);
    if (concurrent.length !== 2) fatal(`并发写应回 2 份结果，实到 ${concurrent.length} 份`);
    const issued = concurrent.map((result, index) =>
      expectOk(result, `同窗并发第 ${index + 1} 个合法写`),
    );
    const seqs = issued.map((receipt) => receipt.streamSeq);
    if (new Set(seqs).size !== seqs.length) {
      fatal(`底座给同一窗的两个并发写发了重号：${seqs.join(",")}`);
    }
    const issuedOrder = [...issued]
      .sort((left, right) => left.streamSeq - right.streamSeq)
      .map((receipt) => receipt.eventId);

    const pageA1 = expectOk(await driver.read(refA, FULL_PAGE), "并发后读窗 A");
    if (pageA1.entries.length !== 2) {
      fatal(`窗 A 并发后应有 2 条，实到 ${pageA1.entries.length} 条`);
    }
    if (stableJson(pageA1.entries.map((entry) => entry.eventId)) !== stableJson(issuedOrder)) {
      fatal(
        `projection 复读顺序与 store 发号顺序不一致：发号 ${issuedOrder.join(",")}，复读 ${pageA1.entries
          .map((entry) => entry.eventId)
          .join(",")}`,
      );
    }

    expectOk(
      await driver.appendWindowEvent({
        residentId,
        windowId: windowB,
        generation: 1,
        idempotencyKey: "wh02-b-1",
        payload: { mark: "wh02-b-1" },
      }),
      "写窗 B",
    );
    const pageB = expectOk(await driver.read(refB, FULL_PAGE), "读窗 B");
    if (stableJson(marksOf(pageB)) !== stableJson(["wh02-b-1"])) {
      fatal(`窗 B 串进了别的窗的事件：${marksOf(pageB).join(",")}`);
    }
    const pageA2 = expectOk(await driver.read(refA, FULL_PAGE), "写过 B 之后再读窗 A");
    if (stableJson(marksOf(pageA2)) !== stableJson(["wh02-a-1", "wh02-a-2"])) {
      fatal(`窗 A 串进了窗 B 的事件：${marksOf(pageA2).join(",")}`);
    }

    const writerBefore = expectOk(await driver.writerIdentity(), "换气前读 writer 身份");
    const rotated = expectOk(
      await driver.rotateGeneration({ residentId, windowId: windowA }),
      "换气",
    );
    if (rotated.windowId !== windowA) {
      fatal(`换气改了 windowId：${windowA} → ${rotated.windowId}`);
    }
    if (rotated.generation !== 2) fatal(`换气应到第 2 代，实到第 ${rotated.generation} 代`);
    const writerAfter = expectOk(await driver.writerIdentity(), "换气后读 writer 身份");
    if (writerAfter.writerId !== writerBefore.writerId) {
      fatal(
        `换气换了 writer（${writerBefore.writerId} → ${writerAfter.writerId}）：清单要求换气不换 writer`,
      );
    }

    const stale = await driver.appendWindowEvent({
      residentId,
      windowId: windowA,
      generation: 1,
      idempotencyKey: "wh02-a-stale",
      payload: { mark: "wh02-a-stale" },
    });
    expectFailClosed(stale, "旧代迟到写");
    if (stale.error.code !== "stale-generation") {
      fatal(
        `旧代迟到写的拒绝理由不是 stale-generation，而是 ${stale.error.code}：拒绝事实不可机器分辨`,
      );
    }

    const fresh = expectOk(
      await driver.appendWindowEvent({
        residentId,
        windowId: windowA,
        generation: 2,
        idempotencyKey: "wh02-a-fresh",
        payload: { mark: "wh02-a-fresh" },
      }),
      "正对照：新代合法写",
    );
    if (fresh.streamSeq <= Math.max(...seqs)) {
      fatal(
        `新代写没有拿到更靠后的发号：并发写到 ${Math.max(...seqs)}，新代写却是 ${fresh.streamSeq}`,
      );
    }

    const retried = await driver.appendWindowEvent({
      residentId,
      windowId: windowA,
      generation: 2,
      idempotencyKey: "wh02-a-fresh",
      payload: { mark: "wh02-a-rewritten" },
    });
    expectFailClosed(retried, "同一幂等把手换内容重试");
    if (retried.error.code !== "idempotency-conflict") {
      fatal(`幂等冲突的拒绝理由不是 idempotency-conflict，而是 ${retried.error.code}`);
    }

    const pageA3 = expectOk(await driver.read(refA, FULL_PAGE), "冲突写之后读窗 A");
    const marks = marksOf(pageA3);
    if (marks.includes("wh02-a-stale")) {
      fatal("被拒的旧代迟到写出现在 projection 里：拒绝被补全了");
    }
    if (marks.includes("wh02-a-rewritten")) {
      fatal("被拒的幂等冲突内容出现在 projection 里：投影被静默改写了");
    }
    if (stableJson(marks) !== stableJson(["wh02-a-1", "wh02-a-2", "wh02-a-fresh"])) {
      fatal(`窗 A 的最终流水不是「两条并发 + 一条新代」：${marks.join(",")}`);
    }
    assertAscending(pageA3, "冲突写之后的窗 A 页");
    for (const [index, expected] of pageFingerprints(pageA1).entries()) {
      if (requireAt(pageFingerprints(pageA3), index, "窗 A 最终页") !== expected) {
        fatal(`已落地的第 ${index + 1} 条在冲突写之后被重排或改写了`);
      }
    }

    return pass(
      "同窗并发由底座串行发号、复读顺序逐项一致；窗间不串；旧代迟到写与幂等冲突写 fail-closed 且在投影侧如实缺席；换气不换 writer",
    );
  }),
};

const wh03: WindowHistoryCheck = {
  id: "WH-03",
  title: "换气前后引用不悬空",
  uses: [
    "startHost",
    "openWindow",
    "appendWindowEvent",
    "rotateGeneration",
    "archiveWindow",
    "read",
    "reset",
  ],
  run: checkBody(async (driver) => {
    await bootHost(driver, "宿主");
    const residentId = "wh03-resident";
    const windowId = "wh03-window";
    await seedWindow(driver, { residentId, windowId, generation: 1, prefix: "wh03-g1", count: 2 });

    const generationRef: WindowHistoryRef = { residentId, windowId, generation: 1 };
    const wholeRef: WindowHistoryRef = { residentId, windowId, generation: null };
    const beforeRotate = expectOk(await driver.read(generationRef, FULL_PAGE), "换气前按代读");
    if (beforeRotate.entries.length !== 2) {
      fatal(`换气前第 1 代应有 2 条，实到 ${beforeRotate.entries.length} 条——正对照不成立`);
    }
    for (const entry of beforeRotate.entries) {
      if (entry.generation !== 1) {
        fatal(`第 1 代切片里混进了第 ${entry.generation} 代的事件`);
      }
    }

    const rotated = expectOk(await driver.rotateGeneration({ residentId, windowId }), "换气");
    if (rotated.windowId !== windowId) {
      fatal(`换气后 windowId 不再逐字相同：${windowId} → ${rotated.windowId}`);
    }
    if (rotated.generation !== 2) fatal(`换气应到第 2 代，实到第 ${rotated.generation} 代`);
    expectOk(
      await driver.appendWindowEvent({
        residentId,
        windowId,
        generation: 2,
        idempotencyKey: "wh03-g2-0",
        payload: { mark: "wh03-g2-0" },
      }),
      "换气后写新代事件",
    );

    const afterRotate = expectOk(await driver.read(generationRef, FULL_PAGE), "换气后拿旧引用读");
    if (afterRotate.entries.length === 0) {
      fatal(
        "换气后旧引用返回空页——这是清单点名的判红样例：空页被当作「一切正常」等于丢了上一代的寻址能力",
      );
    }
    assertSameEntries(beforeRotate, afterRotate, "换气前后的第 1 代切片");

    const whole = expectOk(await driver.read(wholeRef, FULL_PAGE), "按稳定 windowId 读整窗");
    if (whole.entries.length !== 3) {
      fatal(`整窗应有跨两代共 3 条，实到 ${whole.entries.length} 条`);
    }
    if (stableJson(whole.entries.map((entry) => entry.generation)) !== stableJson([1, 1, 2])) {
      fatal(
        `整窗事件没有自带正确的代际：${whole.entries.map((entry) => entry.generation).join(",")}`,
      );
    }
    const wholeIds = new Set(whole.entries.map((entry) => entry.eventId));
    for (const entry of beforeRotate.entries) {
      if (!wholeIds.has(entry.eventId)) {
        fatal(`整窗读丢了第 1 代的事件 ${entry.eventId}：换代后失去对上一代的寻址能力`);
      }
    }

    const archived = expectOk(await driver.archiveWindow({ residentId, windowId }), "归档窗");
    if (!archived.archived) fatal("archiveWindow 返回的描述符没有标记 archived");
    if (archived.windowId !== windowId) fatal("归档改了 windowId");
    const archivedSlice = expectOk(await driver.read(generationRef, FULL_PAGE), "归档后拿旧引用读");
    if (archivedSlice.entries.length === 0) fatal("归档窗读回空页：归档窗不可读");
    assertSameEntries(beforeRotate, archivedSlice, "归档前后的第 1 代切片");
    const archivedWhole = expectOk(await driver.read(wholeRef, FULL_PAGE), "归档后读整窗");
    if (archivedWhole.entries.length !== 3) {
      fatal(`归档后整窗应仍有 3 条，实到 ${archivedWhole.entries.length} 条`);
    }

    return pass(
      "换气前后 windowId 逐字不变；按 (windowId, generation) 取得的引用换气后仍解析到同一批事件；整窗按稳定 windowId 跨代可读；归档窗可读",
    );
  }),
};

const wh04: WindowHistoryCheck = {
  id: "WH-04",
  title: "读不到 fail-closed",
  uses: [
    "startHost",
    "openWindow",
    "appendWindowEvent",
    "read",
    "summarize",
    "injectStorageReadFailure",
    "clearStorageReadFailure",
    "deleteDurableWindowData",
    "corruptDurableEntry",
    "reset",
  ],
  run: checkBody(async (driver) => {
    await bootHost(driver, "宿主");
    const residentId = "wh04-resident";
    const healthyId = "wh04-healthy";
    const emptyId = "wh04-empty";
    const corruptId = "wh04-corrupt";

    const healthy = await seedWindow(driver, {
      residentId,
      windowId: healthyId,
      generation: 1,
      prefix: "wh04-h",
      count: 2,
    });
    const healthyPage = expectOk(await driver.read(healthy.ref, FULL_PAGE), "健康窗读");
    if (healthyPage.entries.length !== 2) {
      fatal(`健康窗应有 2 条，实到 ${healthyPage.entries.length} 条——正对照不成立`);
    }

    // 正对照二：窗存在但确实没有历史。这一支必须成功返回空，才能证明后面的
    // fail-closed 不是「一律报错」蒙过去的。
    const emptyRef: WindowHistoryRef = { residentId, windowId: emptyId, generation: null };
    expectOk(await driver.openWindow({ residentId, windowId: emptyId }), "开一个不写事件的窗");
    const emptyPage = expectOk(await driver.read(emptyRef, FULL_PAGE), "读存在但空的窗");
    if (emptyPage.entries.length !== 0) {
      fatal(`没写过事件的窗读出了 ${emptyPage.entries.length} 条`);
    }
    const emptySummary = expectOk(await driver.summarize(emptyRef), "空窗 summarize");
    if (!emptySummary.blank) fatal("确实没有历史的窗，summarize 没有报 blank");

    await driver.injectStorageReadFailure({ residentId, windowId: healthyId });
    const faultedRead = await driver.read(healthy.ref, FULL_PAGE);
    const faultedSummarize = await driver.summarize(healthy.ref);
    expectFailClosed(faultedRead, "存储读失败下的 read");
    expectFailClosed(faultedSummarize, "存储读失败下的 summarize");
    if (faultedRead.error.windowId !== healthyId) {
      fatal(`读失败的结构化错误没有指出是哪扇窗：windowId=${String(faultedRead.error.windowId)}`);
    }

    await driver.clearStorageReadFailure();
    const recovered = expectOk(await driver.read(healthy.ref, FULL_PAGE), "清掉故障后再读健康窗");
    assertSameEntries(healthyPage, recovered, "故障注入前后的健康窗");

    await driver.deleteDurableWindowData({ residentId, windowId: healthyId });
    const missingRead = await driver.read(healthy.ref, FULL_PAGE);
    const missingSummarize = await driver.summarize(healthy.ref);
    // 「读不到」与「读到是空」必须机器可分：上面那扇空窗走的是 ok 分支（已断言），
    // 这扇数据被删的窗必须走失败分支，两者不能编码成同一种值。
    if (missingRead.ok) {
      fatal(
        `数据缺失时 read 返回了正常结果（${missingRead.value.entries.length} 条）：「读不到」被编码成和「读到是空」同一种值，空页冒充了「这窗没有历史」`,
      );
    }
    if (missingRead.error.message.length === 0) {
      fatal("数据缺失的结构化错误没有 message，调用方拿不到判据");
    }
    expectFailClosed(missingSummarize, "数据缺失下的 summarize");

    const corrupt = await seedWindow(driver, {
      residentId,
      windowId: corruptId,
      generation: 1,
      prefix: "wh04-c",
      count: 3,
    });
    const cleanPage = expectOk(await driver.read(corrupt.ref, FULL_PAGE), "损坏前读");
    if (cleanPage.entries.length !== 3) {
      fatal(`损坏前应有 3 条，实到 ${cleanPage.entries.length} 条`);
    }
    if (cleanPage.damaged.length !== 0) fatal("还没损坏就报了 damaged");
    const middleSeq = requireAt(corrupt.receipts, 1, "损坏目标收据").streamSeq;
    await driver.corruptDurableEntry({ residentId, windowId: corruptId, streamSeq: middleSeq });
    const damagedRead = await driver.read(corrupt.ref, FULL_PAGE);

    if (damagedRead.ok) {
      const page = damagedRead.value;
      if (page.damaged.length === 0) {
        fatal(
          page.entries.length < cleanPage.entries.length
            ? `一页里损坏一条就静默少回一条（${cleanPage.entries.length} → ${page.entries.length}），damaged 还是空：这是静默丢数据`
            : "条目损坏后返回的页与正常页在返回值层面不可分：damaged 为空",
        );
      }
      if (!page.damaged.some((report) => report.streamSeq === middleSeq)) {
        fatal(
          `damaged 没有指出被损坏的 streamSeq=${middleSeq}：${page.damaged
            .map((report) => report.streamSeq)
            .join(",")}`,
        );
      }
      if (pageShape(page) === pageShape(cleanPage)) {
        fatal("损坏后的页与正常页逐字节相同：调用方无法机器分辨");
      }
    } else if (damagedRead.error.code !== "entry-corrupt") {
      fatal(
        `条目损坏报的错不是 entry-corrupt，而是 ${damagedRead.error.code}：损坏的存在不可机器分辨`,
      );
    }

    return pass(
      "存在但空的窗正常返回空页；存储读失败与数据缺失两种故障下 summarize/read 均 fail-closed 且与空页不同值；单条 payload 损坏在返回值层面机器可见",
    );
  }),
};

const wh05: WindowHistoryCheck = {
  id: "WH-05",
  title: "迁移可回滚",
  uses: [
    "startHost",
    "openWindow",
    "appendWindowEvent",
    "read",
    "durableSnapshot",
    "migrationState",
    "migrateStorageFormat",
    "rollbackStorageFormat",
    "interruptMigration",
    "resumeMigration",
    "readTombstones",
    "reset",
  ],
  run: checkBody(async (driver) => {
    await bootHost(driver, "宿主");
    const residentId = "wh05-resident";
    const windowId = "wh05-window";
    await seedWindow(driver, { residentId, windowId, generation: 1, prefix: "wh05", count: 3 });
    const ref: WindowHistoryRef = { residentId, windowId, generation: null };

    const initialState = await driver.migrationState();
    if (initialState.formatVersion !== 1) {
      fatal(`起点格式应是 v1，实到 v${initialState.formatVersion}`);
    }
    const v1Page = expectOk(await driver.read(ref, FULL_PAGE), "v1 读");
    if (v1Page.entries.length !== 3) {
      fatal(`v1 应有 3 条，实到 ${v1Page.entries.length} 条——正对照不成立`);
    }
    for (const entry of v1Page.entries) {
      if (entry.formatVersion !== 1) fatal(`v1 页里混进了 v${entry.formatVersion} 条目`);
    }
    const v1Snapshot = await driver.durableSnapshot();
    if (v1Snapshot.records.length === 0) {
      fatal("迁移前的落盘快照是空的：没有真实记录可比字节");
    }
    const tombstonesBefore = expectOk(await driver.readTombstones(), "迁移前读墓碑");
    if (tombstonesBefore.length !== 0) {
      fatal(`迁移前就有 ${tombstonesBefore.length} 块墓碑：后面的墓碑断言会空转`);
    }

    const migrated = expectOk(
      await driver.migrateStorageFormat({ targetFormatVersion: 2 }),
      "v1→v2 迁移",
    );
    if (migrated.formatVersion !== 2) {
      fatal(`迁移后应报 v2，实到 v${migrated.formatVersion}`);
    }
    const v2State = await driver.migrationState();
    if (v2State.formatVersion !== 2 || v2State.status !== "complete") {
      fatal(`迁移后状态不对：v${v2State.formatVersion} / ${v2State.status}`);
    }
    const v2Page = expectOk(await driver.read(ref, FULL_PAGE), "v2 读");
    assertSameEntries(v1Page, v2Page, "迁移前后的 port 读数");
    for (const entry of v2Page.entries) {
      if (entry.formatVersion !== 2) {
        fatal(`迁移后仍有 v${entry.formatVersion} 条目：这是 v1/v2 混合页`);
      }
    }

    const tombstones = expectOk(await driver.readTombstones(), "迁移后读墓碑");
    if (tombstones.length === 0) {
      fatal("被 v2 取代的旧信号点没有留显式墓碑：无声消失不许");
    }
    for (const tombstone of tombstones) {
      if (
        tombstone.tombstoneId.length === 0 ||
        tombstone.retiredField.length === 0 ||
        tombstone.reason.length === 0
      ) {
        fatal(`墓碑字段不完整：${stableJson({ ...tombstone })}`);
      }
    }
    const tombstoneIds = new Set(tombstones.map((tombstone) => tombstone.tombstoneId));
    if (migrated.tombstoneIds.length === 0) {
      fatal("迁移结果没有报出任何墓碑 id");
    }
    for (const id of migrated.tombstoneIds) {
      if (!tombstoneIds.has(id)) fatal(`迁移报出的墓碑 ${id} 读不回来`);
    }

    const rolledBack = expectOk(
      await driver.rollbackStorageFormat({ targetFormatVersion: 1 }),
      "v2→v1 回滚",
    );
    if (rolledBack.formatVersion !== 1) {
      fatal(`回滚后应报 v1，实到 v${rolledBack.formatVersion}`);
    }
    const rolledBackState = await driver.migrationState();
    if (rolledBackState.formatVersion !== 1) {
      fatal(`回滚后状态里的格式版本没退回：v${rolledBackState.formatVersion}`);
    }
    const afterRollback = await driver.durableSnapshot();
    if (snapshotShape(afterRollback) !== snapshotShape(v1Snapshot)) {
      fatal(
        `退回后逐条记录与迁移前不是字节等价：\n  前 ${snapshotShape(v1Snapshot)}\n  后 ${snapshotShape(afterRollback)}`,
      );
    }
    const rolledBackPage = expectOk(await driver.read(ref, FULL_PAGE), "回滚后读");
    assertSameEntries(v1Page, rolledBackPage, "回滚前后的 port 读数");

    // —— 迁移中断态单判 ——
    await driver.interruptMigration({ targetFormatVersion: 2, fault: "host-killed" });
    await bootHost(driver, "迁移被打断后重启的宿主");
    const interruptedState = await driver.migrationState();
    const interruptedRead = await driver.read(ref, FULL_PAGE);

    const recognizable =
      interruptedState.status === "incomplete" &&
      (interruptedState.resumable || interruptedState.rollbackAvailable);
    const atomic =
      interruptedState.status === "complete" ||
      interruptedState.status === "rolled-back" ||
      interruptedState.status === "none";
    if (!recognizable && !atomic) {
      fatal(
        `迁移中断后既不可识别为「未完成且可续跑/可退回」，也不是原子结果：${stableJson({
          status: interruptedState.status,
          resumable: interruptedState.resumable,
          rollbackAvailable: interruptedState.rollbackAvailable,
        })}`,
      );
    }
    if (interruptedRead.ok) {
      const versions = new Set(interruptedRead.value.entries.map((entry) => entry.formatVersion));
      if (versions.size > 1) {
        fatal(
          `重启后 port 读出 v1/v2 混合页（${[...versions].join("、")}）且被当作正常数据：清单点名判红`,
        );
      }
    } else if (interruptedRead.error.code !== "migration-incomplete") {
      fatal(
        `迁移未完成态下 read 报的错不是 migration-incomplete，而是 ${interruptedRead.error.code}`,
      );
    }

    if (interruptedState.status === "incomplete") {
      const repaired = interruptedState.resumable
        ? await driver.resumeMigration()
        : await driver.rollbackStorageFormat({ targetFormatVersion: 1 });
      expectOk(repaired, interruptedState.resumable ? "续跑迁移" : "整体退回");
      const repairedState = await driver.migrationState();
      if (repairedState.status === "incomplete") {
        fatal("声称可续跑/可退回，做完之后状态仍是 incomplete");
      }
      const repairedPage = expectOk(await driver.read(ref, FULL_PAGE), "修复后读");
      const repairedVersions = new Set(repairedPage.entries.map((entry) => entry.formatVersion));
      if (repairedVersions.size > 1) {
        fatal(`修复后仍是混合页：${[...repairedVersions].join("、")}`);
      }
      if (repairedPage.entries.length !== 3) {
        fatal(`修复后条目数变了：应 3 条，实到 ${repairedPage.entries.length} 条`);
      }
    } else {
      const atomicPage = expectOk(interruptedRead, "原子迁移下中断后读");
      const atomicVersions = new Set(atomicPage.entries.map((entry) => entry.formatVersion));
      if (atomicVersions.size > 1) {
        fatal(`号称原子却读出混合页：${[...atomicVersions].join("、")}`);
      }
      if (atomicPage.entries.length !== 3) {
        fatal(`原子迁移中断后条目数变了：应 3 条，实到 ${atomicPage.entries.length} 条`);
      }
    }

    return pass(
      "v1→v2 迁移后 port 读数不变且留显式墓碑；退回 v1 后逐条记录字节等价、读数不变；迁移中断重启后要么可识别为未完成且可续跑/可退回，要么原子，且不出 v1/v2 混合页",
    );
  }),
};

const wh06: WindowHistoryCheck = {
  id: "WH-06",
  title: "写入路径唯一",
  // 静态灯：由代码检索与类型检查提供证据，不经驱动自述。
  uses: [],
  async run(): Promise<WindowHistoryCheckResult> {
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const audit = auditWindowHistoryWriteSurface(sourceRoot);
    if (audit.findings.length > 0) {
      return fail(
        audit.findings.map((finding) => `[${finding.kind}] ${finding.detail}`).join("；"),
      );
    }
    const ports = audit.portDeclarations
      .map((declaration) => `${declaration.file}:${declaration.typeName}`)
      .join("、");
    return pass(
      `port ${ports} 上只有 summarize/read；唯一写方在 ${audit.writerConstructionSites.join("、")}；projection 目录 ${audit.projectionFiles.length} 个文件既不持有 writer 也不自带落盘写调用`,
    );
  },
};

export const windowHistoryChecks: readonly WindowHistoryCheck[] = [
  wh01,
  wh02,
  wh03,
  wh04,
  wh05,
  wh06,
];

/** 导出给契约测试：不能出现漏号、重号或顺序漂移。 */
export const expectedWindowHistoryCheckIds = [
  "WH-01",
  "WH-02",
  "WH-03",
  "WH-04",
  "WH-05",
  "WH-06",
] as const;
