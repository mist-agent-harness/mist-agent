/**
 * 逐回合模型 usage 运行日志（#227 第 2 项）。
 *
 * 只落**非敏感 metadata 与数值**：住户号、代际、模型、上游报出来的 token 计数与花费。
 * 不落 prompt / 历史 / 密钥 / 工具输出——它是运行日志（RT-06 扫描面之一），不是第二份
 * 聊天史。文件名 `<residentId>.usage.jsonl` 走 RT-06 的按户界命名公约，扫描面不会漏它。
 *
 * 两个量分开（#227 读数边界）：
 * - `cumulative`：把每回合**上游真报出来**的字段逐字段累加（某回合缺该字段就跳过那次，
 *   不补零），只描述已记录回合的 reported 数值；成本是上游估算，不是账单。
 * - `contextOccupancy`：当前上下文占用（窗口里现在装了多少）——**本文件不产出它**。
 *   本运行时对上下文的估算门（breath）另有其物，usage 日志不许拿累计值去冒充占用，
 *   也不改那道门。
 *
 * 缺失 = 未知：上游没报的字段不写、不补零、不估算。一条记录里出现 0 是因为上游报了 0，
 * 不是 mist 替它填的。
 */
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TurnUsage } from "./channels.ts";
import { USAGE_FIELDS, normalizeTurnUsage } from "./model-usage.ts";

/** 一条逐回合记录：只有非敏感 metadata/数值。 */
export interface TurnUsageRecord {
  readonly turnId: string;
  readonly generation: number;
  readonly model: string;
  readonly adapterId: string;
  readonly at: string;
  /** 本回合上游报告的 usage；上游没报则整块缺席（不是空对象、不是零）。 */
  readonly turn?: TurnUsage;
}

/** 读口返回：逐回合记录 + 逐字段累加，两者都缺省为「没有」。 */
export interface TurnUsageView {
  readonly turns: readonly (TurnUsageRecord & { readonly residentId: string })[];
  /**
   * 逐字段累加；没有任何字段被报过时为空对象。**按字段覆盖**：某字段只在该字段被
   * 上游报过的回合里累加，所以它反映的是「至少报过该字段的那些回合」——不是每个字段
   * 都覆盖了所有回合。`cumulativeCoverage` 写明每个字段覆盖了几个回合、总回合数多少，
   * 免得部分求和被当成完整总量。
   */
  readonly cumulative: TurnUsage;
  readonly cumulativeCoverage: {
    readonly totalTurns: number;
    readonly perField: Readonly<Partial<Record<keyof TurnUsage, number>>>;
  };
  /**
   * 最近一次写日志失败的原因；null = 没有已知失败。用于如实暴露「某些回合没记上」，
   * 不吞错也不伪报已记录。
   */
  readonly logError: string | null;
  /** 损坏/截断记录被跳过的条数；有效记录继续可读，不包含坏行正文。 */
  readonly invalidRecords: number;
}

type UsageField = (typeof USAGE_FIELDS)[number];

export class TurnUsageLog {
  readonly #dir: string;
  /** 最近一次写日志失败的如实记录（按住户）。写日志失败不许改真实回合语义。 */
  readonly #lastError = new Map<string, string>();

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(this.#dir, { recursive: true });
  }

  /**
   * 追加一条逐回合记录（append-only）。上游没报 usage 时 `turn` 缺席。
   *
   * **返回结果而不是抛出**：这是运行日志，调用方（真实聊天回合）**不许**因为写日志
   * 失败就改变聊天/ACK/回合完成语义。失败如实返回，由调用方标记
   * 「这一条没记上」——不吞错、也不伪报已记录。
   */
  record(residentId: string, record: TurnUsageRecord): { ok: true } | { ok: false; error: string } {
    try {
      const usage = normalizeTurnUsage(record.turn);
      const safe: TurnUsageRecord = {
        turnId: record.turnId,
        generation: record.generation,
        model: record.model,
        adapterId: record.adapterId,
        at: record.at,
        ...(usage === undefined ? {} : { turn: usage }),
      };
      const fd = this.#open(residentId, true);
      try {
        fchmodSync(fd, 0o600);
        const size = fstatSync(fd).size;
        const last = Buffer.alloc(1);
        const needsNewline = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
        writeFileSync(fd, `${needsNewline ? "\n" : ""}${JSON.stringify(safe)}\n`, {
          encoding: "utf8",
        });
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = `usage 日志未记录${typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `（${code}）` : ""}`;
      this.#lastError.set(residentId, message);
      return { ok: false, error: message };
    }
  }

  /** 按住户读回全部记录与逐字段累加。文件不存在 = 还没记过（空视图，不是错误）。 */
  read(residentId: string): TurnUsageView {
    let content: string;
    try {
      const fd = this.#open(residentId, false);
      try {
        content = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.#view([], residentId);
      }
      throw error;
    }
    const turns: (TurnUsageRecord & { residentId: string })[] = [];
    let invalidRecords = 0;
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        invalidRecords += 1;
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        invalidRecords += 1;
        continue;
      }
      const row = parsed as Record<string, unknown>;
      if (
        typeof row.turnId !== "string" ||
        typeof row.model !== "string" ||
        typeof row.adapterId !== "string" ||
        typeof row.at !== "string" ||
        typeof row.generation !== "number" ||
        !Number.isSafeInteger(row.generation) ||
        row.generation < 0
      ) {
        invalidRecords += 1;
        continue;
      }
      const usage = normalizeTurnUsage(row.turn);
      turns.push({
        residentId,
        turnId: row.turnId,
        model: row.model,
        adapterId: row.adapterId,
        at: row.at,
        generation: row.generation,
        ...(usage === undefined ? {} : { turn: usage }),
      });
    }
    return this.#view(turns, residentId, invalidRecords);
  }

  #view(
    turns: (TurnUsageRecord & { residentId: string })[],
    residentId: string,
    invalidRecords = 0,
  ): TurnUsageView {
    const sums: Record<UsageField, number> = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costTotal: 0,
    };
    const seen: Record<UsageField, boolean> = {
      input: false,
      output: false,
      cacheRead: false,
      cacheWrite: false,
      totalTokens: false,
      costTotal: false,
    };
    const coverage: { [K in UsageField]?: number } = {};
    let totalTurns = 0;
    for (const turn of turns) {
      totalTurns += 1;
      if (turn.turn === undefined) continue;
      for (const field of USAGE_FIELDS) {
        const value = turn.turn[field];
        if (typeof value === "number") {
          sums[field] += value;
          seen[field] = true;
          coverage[field] = (coverage[field] ?? 0) + 1;
        }
      }
    }
    const cumulative: { [K in UsageField]?: number } = {};
    for (const field of USAGE_FIELDS) {
      if (seen[field]) cumulative[field] = sums[field];
    }
    return {
      turns,
      cumulative: normalizeTurnUsage(cumulative) ?? {},
      cumulativeCoverage: { totalTurns, perField: coverage },
      logError: this.#lastError.get(residentId) ?? null,
      invalidRecords,
    };
  }

  #path(residentId: string): string {
    return join(this.#dir, `${residentId}.usage.jsonl`);
  }

  #open(residentId: string, writing: boolean): number {
    const path = this.#path(residentId);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe usage log target");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const flags = writing
      ? constants.O_RDWR | constants.O_CREAT | constants.O_APPEND
      : constants.O_RDONLY;
    // 非阻塞打开避免检查后被替换为 FIFO 等特殊文件时把聊天挂住；普通文件语义不变。
    const fd = openSync(
      path,
      flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      closeSync(fd);
      throw new Error("Unsafe usage log target");
    }
    return fd;
  }
}
