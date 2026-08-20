/**
 * 权威事实账 —— 多 viewport 地基的横向连续性（图纸 docs/design/multi-viewport.md §3，
 * D7 第四前置）。本文件只做账本体：append-only 日志、推导视图、窗级确认位。
 * 接线进派发链（开工闸拦截、启动包注入）不在这里，那是泳道 1 合入后的事。
 *
 * 每住户一本账，条目 {seq, ts, author, kind, body}，seq 由账侧发号、单调递增。
 * 账上没有任何可变字段，变化只有「追加」这一种形状：解除一条承诺不是改旧条目
 * 的标记，而是追加一条 kind=supersede 的新账目（body 写解除理由，supersedesSeq
 * 指旧 seq）——旧条目一个字节不动。已 ack 旧条目的窗下一轮经缺口通道拉到这条
 * supersede；就地改标记等于让解除静默失踪（「送达 ≠ 仍然有效」事故形状）。
 *
 * 两条铁律：
 *
 * 1. 现行有效集是从日志推导的视图，不是账上的字段。所有事实条目中未被
 *    supersede 指名的均属现行有效集，supersede 只进全史与缺口传播——
 *    同一种 kind 多条并行生效是常态；全史留作追溯，按需查询（entries()）。
 * 2. 新鲜度判据只有序号差值。禁止 last_synced_at 式时间戳判断——它分不清
 *    「没有新东西」和「同步失败」。ts 只为追溯与展示存在，绝不参与缺口判断；
 *    测试里专门喂了一份 ts 倒序的快照来钉死这一点（MV-C06）。
 *
 * 查账失败只有一种形状：unknown。它与「查到是零」在类型上就是两个值——
 * GapProbe 的 unknown 分支根本不携带数字，调用方想把它当 0 用，类型系统
 * 不答应（MV-C03）。fail-closed 的拦截动作本身在派发链上，不在账里。
 */

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** 能落账的三种事实。supersede 不是事实，是对事实的解除，只能走 supersede() 追加。 */
export type FactKind = "ruling" | "active_rule" | "confirmed_preference";
export type LedgerEntryKind = FactKind | "supersede";

const FACT_KINDS: readonly FactKind[] = ["ruling", "active_rule", "confirmed_preference"];

/**
 * 账目条目。图纸五字段之外有一个 supersedesSeq：kind=supersede 时指被解除条目的
 * seq（机器可读指针，推导视图靠它，不去解析 body 字符串）；其余 kind 恒为 null。
 * 它同样是不可变字段——追加时定死，之后无任何写入路径。
 */
export interface LedgerEntry {
  readonly seq: number;
  readonly ts: string;
  readonly author: string;
  readonly kind: LedgerEntryKind;
  readonly body: string;
  readonly supersedesSeq: number | null;
}

/** 跨住户访问时抛这个，不返回空账——静默的空结果会把 bug 藏起来（同 ResidentStore 的房规）。 */
export class LedgerNotFoundError extends Error {
  constructor(residentId: string) {
    super(`no such ledger: ${residentId}`);
    this.name = "LedgerNotFoundError";
  }
}

/** 查一扇没开过户的窗的确认位时抛。 */
export class ViewportNotFoundError extends Error {
  constructor(residentId: string, viewportId: string) {
    super(`no ack row for viewport ${viewportId} in ledger of ${residentId}`);
    this.name = "ViewportNotFoundError";
  }
}

/** supersede 指向不存在的 seq 时抛。 */
export class LedgerEntryNotFoundError extends Error {
  constructor(residentId: string, targetSeq: number) {
    super(`no such ledger entry in ${residentId}: seq ${targetSeq}`);
    this.name = "LedgerEntryNotFoundError";
  }
}

/** 解除动作本身不合法：目标是另一条 supersede，或该条目已被解除过。 */
export class InvalidSupersedeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSupersedeError";
  }
}

/** 确认位只前进不后退，也不能确认账上还不存在的 seq。 */
export class AckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AckError";
  }
}

/**
 * 缺口探针的返回形状（MV-C03 的落点）。
 *
 * 「查不到」（unknown）与「查到是零」（ok 且 latestSeq=ackedSeq=0）是两个
 * 不同的值，不是同一个 0：unknown 分支没有数字可拿。闸侧拿到 unknown 时
 * 裁定级动作 fail-closed、普通动作放行并记日志——那是派发链的职责；账侧
 * 保证的是这两种状况永远无法被编码成同一个值。
 */
export type GapProbe =
  | { status: "ok"; latestSeq: number; ackedSeq: number }
  | { status: "unknown"; cause: string };

/** 一扇窗的确认位。它是游标不是账目：只前进、可落盘，不属于 append-only 约束。 */
interface ViewportAckRow {
  /** 开窗那一刻的 latestSeq；新窗 ackedSeq 从 baseline 起算，不背全史（MV-A05）。 */
  baselineSeq: number;
  ackedSeq: number;
}

interface ResidentLedger {
  residentId: string;
  entries: LedgerEntry[];
  /** 已被解除的 seq 集合——推导视图的索引，随 supersede 追加而增长，条目本身不变。 */
  supersededSeqs: Set<number>;
  viewports: Map<string, ViewportAckRow>;
}

/**
 * 落盘记录：`<dataDir>/<residentId>.facts.json` 的文件内容。
 * 与 ResidentStore 的 `<residentId>.json` 刻意不同名，两个存储可以共用一个目录。
 */
interface LedgerRecord {
  schemaVersion: number;
  residentId: string;
  entries: LedgerEntry[];
  viewports: { viewportId: string; baselineSeq: number; ackedSeq: number }[];
}

const SCHEMA_VERSION = 1;
const FILE_SUFFIX = ".facts.json";

export class FactLedger {
  readonly #ledgers = new Map<string, ResidentLedger>();

  /**
   * 落盘目录；null = 纯内存（判卷和单元测试的默认形态，不产生任何文件）。
   * 持久化沿用 ResidentStore 定稿的方案：每住户一份带 schema_version 的 JSON
   * 快照，临时文件 → fsync → 原子 rename，成功才返回。认下的代价相同：
   * 每写 O(ledger size)、单写者——不冒充长期并发方案。
   */
  readonly #dataDir: string | null;

  /** ts 只用于展示与追溯，不参与任何判断（铁律 2），单调化只为同毫秒条目排序稳定。 */
  #lastStamp = 0;

  constructor(options: { dataDir?: string } = {}) {
    this.#dataDir = options.dataDir ?? null;
    if (this.#dataDir !== null) {
      mkdirSync(this.#dataDir, { recursive: true });
      this.#restore(this.#dataDir);
    }
  }

  /** 同一进程内单调递增的时间戳，避免同毫秒条目排序不稳定。 */
  #nextStamp(): string {
    const now = Date.now();
    this.#lastStamp = now > this.#lastStamp ? now : this.#lastStamp + 1;
    return new Date(this.#lastStamp).toISOString();
  }

  // --- 账的生死 ---

  /**
   * 给住户开一本空账。显式开户而不是首次写入时隐式建账：
   * 「这个住户没有账」必须是一个响亮的错误，不能被静默建账吞掉。
   */
  createLedger(residentId: string): void {
    if (this.#ledgers.has(residentId)) {
      throw new Error(`ledger already exists: ${residentId}`);
    }
    const ledger: ResidentLedger = {
      residentId,
      entries: [],
      supersededSeqs: new Set(),
      viewports: new Map(),
    };
    this.#ledgers.set(residentId, ledger);
    this.#persist(ledger);
  }

  has(residentId: string): boolean {
    return this.#ledgers.has(residentId);
  }

  /** 拿账。拿不到就抛——这是跨住户隔离的唯一入口。 */
  #ledger(residentId: string): ResidentLedger {
    const ledger = this.#ledgers.get(residentId);
    if (ledger === undefined) throw new LedgerNotFoundError(residentId);
    return ledger;
  }

  #viewportRow(ledger: ResidentLedger, viewportId: string): ViewportAckRow {
    const row = ledger.viewports.get(viewportId);
    if (row === undefined) throw new ViewportNotFoundError(ledger.residentId, viewportId);
    return row;
  }

  // --- 追加（账上唯一的写形状）---

  /**
   * 落一条事实。seq 由账侧发号——调用方没有传 seq 的入口，外部想伪造
   * 序号得先改这个类，那是 review 看得见的越权。
   */
  append(residentId: string, input: { author: string; kind: FactKind; body: string }): LedgerEntry {
    const ledger = this.#ledger(residentId);
    // 运行时校验给绕过类型系统的调用方：supersede 走 append 会造出没有
    // supersedesSeq 指针的解除条目，推导视图直接被毒化。
    if (!FACT_KINDS.includes(input.kind)) {
      throw new Error(
        `append only accepts ${FACT_KINDS.join("/")}, got ${String(input.kind)} —— 解除走 supersede()`,
      );
    }
    return this.#appendEntry(ledger, input.author, input.kind, input.body, null);
  }

  /**
   * 解除一条已落账的事实。追加一条 kind=supersede 的账目，旧条目一个字节不动。
   *
   * 目标必须存在、必须是一条事实（不能解除一条解除）、且此前未被解除过——
   * 重复解除不会让账出错（条目已死，再死一次语义不变），但静默放行会把
   * 「操作方以为没解除过」这件事藏起来；这里选择显式报错。若主笔拍板重复
   * 解除应幂等放行，改这里加一个测试即可。
   */
  supersede(
    residentId: string,
    targetSeq: number,
    input: { author: string; reason: string },
  ): LedgerEntry {
    const ledger = this.#ledger(residentId);
    const target = ledger.entries[targetSeq - 1];
    if (target === undefined || target.seq !== targetSeq) {
      throw new LedgerEntryNotFoundError(residentId, targetSeq);
    }
    if (target.kind === "supersede") {
      throw new InvalidSupersedeError(
        `entry seq ${targetSeq} is itself a supersede —— 解除一条解除不在图纸语义内`,
      );
    }
    if (ledger.supersededSeqs.has(targetSeq)) {
      throw new InvalidSupersedeError(`entry seq ${targetSeq} is already superseded`);
    }
    const entry = this.#appendEntry(ledger, input.author, "supersede", input.reason, targetSeq);
    ledger.supersededSeqs.add(targetSeq);
    return entry;
  }

  #appendEntry(
    ledger: ResidentLedger,
    author: string,
    kind: LedgerEntryKind,
    body: string,
    supersedesSeq: number | null,
  ): LedgerEntry {
    const entry: LedgerEntry = {
      seq: ledger.entries.length + 1,
      ts: this.#nextStamp(),
      author,
      kind,
      body,
      supersedesSeq,
    };
    // 冻结石彻 append-only 的最后一步：即使有人拿到账内引用（持久化恢复
    // 之外的路径都返回副本），运行时也拒绝任何涂改。
    ledger.entries.push(Object.freeze(entry));
    this.#persist(ledger);
    return { ...entry };
  }

  // --- 推导视图与追溯 ---

  /** 账上最后一条的 seq；空账为 0。 */
  latestSeq(residentId: string): number {
    return this.#ledger(residentId).entries.length;
  }

  /**
   * 归档查询：全史原样返回（含已被解除的条目），按 seq 升序。
   * 返回副本——改返回值涂改不了账。
   */
  entries(residentId: string): LedgerEntry[] {
    return this.#ledger(residentId).entries.map((entry) => ({ ...entry }));
  }

  /**
   * 现行有效集：所有事实条目中，未被任何 supersede 条目指名的条目均属现行
   * 有效集；supersede 条目只进入全史与缺口传播，不进入现行有效集
   * （2026-08-20 主笔定案文案，一字未改）。事实条目即 kind 为
   * ruling / active_rule / confirmed_preference 的条目。
   *
   * 同一种 kind 多条并行生效是常态——supersede 精确指向单条 seq，不存在
   * 「最新一条盖掉旧条」的隐含语义。supersede 不进集的理由（主笔定案
   * 论据）：它永不被指名，字面义下每次解除往集里永久塞一条，集合单调
   * 膨胀，全史会从启动包这个口子漏回新窗，与「新窗不背全史」相撞。
   *
   * 这是从日志现推的视图，账上没有对应的字段——它永远不可能和日志脱节，
   * 因为它就是日志。
   */
  currentSet(residentId: string): LedgerEntry[] {
    const ledger = this.#ledger(residentId);
    return ledger.entries
      .filter((entry) => entry.kind !== "supersede" && !ledger.supersededSeqs.has(entry.seq))
      .map((entry) => ({ ...entry }));
  }

  // --- 窗级确认位（viewport 一词从 glossary，图纸上说的「窗」）---

  /**
   * 开一扇窗的确认位。baselineSeq = 开窗那一刻的 latestSeq，新窗的 ackedSeq
   * 从 baseline 起算——append-only 的账配 ackedSeq=0 会让新窗的缺口等于全史
   * （MV-A05）。开窗前已落账的事实如需追溯，走 entries() 归档查询，不走缺口通道。
   *
   * viewportId 对账是不透明字符串；它的发号（w_ + ULID）是宿主的事，不在这里校验。
   */
  openViewport(residentId: string, viewportId: string): number {
    const ledger = this.#ledger(residentId);
    if (ledger.viewports.has(viewportId)) {
      throw new Error(`ack row already exists for viewport ${viewportId} in ${residentId}`);
    }
    const baselineSeq = ledger.entries.length;
    ledger.viewports.set(viewportId, { baselineSeq, ackedSeq: baselineSeq });
    this.#persist(ledger);
    return baselineSeq;
  }

  /**
   * 缺口 = 序号差值，只有这一个判据（铁律 2）。
   * 查不到住户或窗就抛——调用方若需要「失败不炸」的形状，用 probeGap()。
   */
  gap(residentId: string, viewportId: string): { latestSeq: number; ackedSeq: number } {
    const ledger = this.#ledger(residentId);
    const row = this.#viewportRow(ledger, viewportId);
    return { latestSeq: ledger.entries.length, ackedSeq: row.ackedSeq };
  }

  /**
   * 永不抛的缺口探针：任何查账失败都归一成 { status: "unknown" }。
   * unknown 分支不携带数字，与「查到是零」在类型上不可混（MV-C03）。
   */
  probeGap(residentId: string, viewportId: string): GapProbe {
    try {
      const { latestSeq, ackedSeq } = this.gap(residentId, viewportId);
      return { status: "ok", latestSeq, ackedSeq };
    } catch (error) {
      return { status: "unknown", cause: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 拉缺口条目：seq > ackedSeq 的全部账目，升序。回执丢失时窗重拉的就是这份。 */
  gapEntries(residentId: string, viewportId: string): LedgerEntry[] {
    const ledger = this.#ledger(residentId);
    const row = this.#viewportRow(ledger, viewportId);
    return ledger.entries
      .filter((entry) => entry.seq > row.ackedSeq)
      .map((entry) => ({ ...entry }));
  }

  /**
   * 回执：窗确认自己已看到 seq。只前进不后退；重复 ack 同一个 seq 幂等放行
   * （回执重发是传播机制的常态，MV-C05）；ack 账上不存在的 seq 显式报错。
   * 无回执 = 尚未知悉——账上不存在「违约」这种标记，回执丢失算传播机制的账，
   * 不算窗的。
   */
  ack(residentId: string, viewportId: string, seq: number): void {
    const ledger = this.#ledger(residentId);
    const row = this.#viewportRow(ledger, viewportId);
    if (!Number.isInteger(seq) || seq < 0) {
      throw new AckError(`ack seq must be a non-negative integer, got ${String(seq)}`);
    }
    if (seq > ledger.entries.length) {
      throw new AckError(
        `cannot ack seq ${seq}: latestSeq is ${ledger.entries.length} —— 不能确认账上还不存在的条目`,
      );
    }
    if (seq < row.ackedSeq) {
      throw new AckError(
        `ack regression for viewport ${viewportId}: ${row.ackedSeq} -> ${seq} —— 确认位只前进不后退`,
      );
    }
    if (seq === row.ackedSeq) return; // 重复回执，幂等
    row.ackedSeq = seq;
    this.#persist(ledger);
  }

  /** 窗的确认位只读视图。 */
  ackedSeq(residentId: string, viewportId: string): number {
    return this.#viewportRow(this.#ledger(residentId), viewportId).ackedSeq;
  }

  // --- 持久化（dataDir 未设时整段短路，判卷路径零文件 IO）---

  /** 把一本账写进它自己的快照文件。同步写：返回即已落盘。 */
  #persist(ledger: ResidentLedger): void {
    if (this.#dataDir === null) return;
    const residentId = ledger.residentId;
    // 这条断言防的是「将来某个改动让外部输入流进文件名」。
    if (!/^[a-z0-9-]+$/.test(residentId)) {
      throw new Error(`resident id 不可作为文件名: ${residentId}`);
    }
    const record: LedgerRecord = {
      schemaVersion: SCHEMA_VERSION,
      residentId,
      entries: ledger.entries,
      viewports: [...ledger.viewports.entries()].map(([viewportId, row]) => ({
        viewportId,
        baselineSeq: row.baselineSeq,
        ackedSeq: row.ackedSeq,
      })),
    };
    const finalPath = join(this.#dataDir, `${residentId}${FILE_SUFFIX}`);
    const tmpPath = `${finalPath}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tmpPath, "w", 0o600);
      fchmodSync(fd, 0o600);
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmpPath, finalPath);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // 保留原始写入错误；close 的二次错误不该遮住病因。
        }
      }
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // 预先存在的同名目录等异常目标可能删不掉；写入仍显式失败。
      }
      throw error;
    }
  }

  /**
   * 启动恢复：读全部快照重建内存视图。坏档显式失败，绝不静默跳过——
   * 静默跳过一个住户等于这本账无声消失，裁定还在生效却无人知道。
   */
  #restore(dataDir: string): void {
    for (const file of readdirSync(dataDir).sort()) {
      // .tmp 是没写完的一次写入，旧 .json 才是权威——跳过即可，下次写会覆盖。
      if (!file.endsWith(FILE_SUFFIX)) continue;
      const record = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as LedgerRecord;
      if (record.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
          `快照 ${file} 的 schema_version=${record.schemaVersion}，本进程只认 ${SCHEMA_VERSION}——显式失败等人来迁移，不静默跳过`,
        );
      }
      if (`${record.residentId}${FILE_SUFFIX}` !== file) {
        throw new Error(`快照 ${file} 内容声称自己是 ${record.residentId}，文件名与身份对不上`);
      }
      this.#restoreEntries(record);
      this.#restoreViewports(record);
      this.#ledgers.set(record.residentId, {
        residentId: record.residentId,
        entries: record.entries.map((entry) => Object.freeze({ ...entry })),
        supersededSeqs: new Set(
          record.entries.flatMap((entry) =>
            entry.kind === "supersede" && entry.supersedesSeq !== null ? [entry.supersedesSeq] : [],
          ),
        ),
        viewports: new Map(
          record.viewports.map((row) => [
            row.viewportId,
            { baselineSeq: row.baselineSeq, ackedSeq: row.ackedSeq },
          ]),
        ),
      });
      for (const entry of record.entries) {
        const t = Date.parse(entry.ts);
        if (Number.isFinite(t) && t > this.#lastStamp) this.#lastStamp = t;
      }
    }
  }

  /** 条目校验：seq 必须从 1 起连续——账侧发号的不变量，断档就是档坏了。 */
  #restoreEntries(record: LedgerRecord): void {
    const restoredSupersededSeqs = new Set<number>();
    for (let i = 0; i < record.entries.length; i += 1) {
      const entry = record.entries[i];
      if (entry === undefined) {
        throw new Error(`快照 ${record.residentId} 的第 ${i + 1} 条是空洞——坏档，拒绝启动`);
      }
      if (entry.seq !== i + 1) {
        throw new Error(
          `快照 ${record.residentId} 的 seq 断档：第 ${i + 1} 条声称 seq=${entry.seq}——append-only 的账不该有洞，拒绝带着疑问启动`,
        );
      }
      const isFactKind = (FACT_KINDS as readonly string[]).includes(entry.kind);
      if (!isFactKind && entry.kind !== "supersede") {
        throw new Error(
          `快照 ${record.residentId} 的 seq=${entry.seq} 带着未知 kind=${String(entry.kind)}——字段形状对不上`,
        );
      }
      if (entry.kind === "supersede") {
        const targetSeq = entry.supersedesSeq;
        if (
          !Number.isInteger(targetSeq) ||
          targetSeq === null ||
          targetSeq < 1 ||
          targetSeq >= entry.seq
        ) {
          throw new Error(
            `快照 ${record.residentId} 的 seq=${entry.seq} 是 supersede 但 supersedesSeq=${String(entry.supersedesSeq)} 不指向前面的条目`,
          );
        }
        const target = record.entries[targetSeq - 1];
        if (target === undefined || target.kind === "supersede") {
          throw new Error(
            `快照 ${record.residentId} 的 seq=${entry.seq} 试图解除 seq=${targetSeq}，但目标不是事实条目`,
          );
        }
        if (restoredSupersededSeqs.has(targetSeq)) {
          throw new Error(
            `快照 ${record.residentId} 重复解除 seq=${targetSeq}——恢复路径必须与 append 路径保持同一不变量`,
          );
        }
        restoredSupersededSeqs.add(targetSeq);
      } else if (entry.supersedesSeq !== null) {
        throw new Error(
          `快照 ${record.residentId} 的 seq=${entry.seq} 是 ${entry.kind} 却带着 supersedesSeq——字段形状对不上`,
        );
      }
    }
  }

  /** 确认位校验：baseline ≤ acked ≤ latestSeq，越界就是档坏了。 */
  #restoreViewports(record: LedgerRecord): void {
    const latestSeq = record.entries.length;
    const seen = new Set<string>();
    for (const row of record.viewports) {
      if (seen.has(row.viewportId)) {
        throw new Error(`快照 ${record.residentId} 里 viewport ${row.viewportId} 有两行确认位`);
      }
      seen.add(row.viewportId);
      if (
        !Number.isInteger(row.baselineSeq) ||
        !Number.isInteger(row.ackedSeq) ||
        row.baselineSeq < 0 ||
        row.ackedSeq < row.baselineSeq ||
        row.ackedSeq > latestSeq
      ) {
        throw new Error(
          `快照 ${record.residentId} 里 viewport ${row.viewportId} 的确认位越界：baseline=${row.baselineSeq} acked=${row.ackedSeq} latest=${latestSeq}`,
        );
      }
    }
  }
}
