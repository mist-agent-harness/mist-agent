/**
 * 换气线与交接信面（RT-03 / D8）。
 *
 * 分工：本文件只管两件持久化事实——触发线配置（成员级，谁改的、何时生效）与
 * 交接信落盘（时间线）。换气的编排走现役 BreathCycle（session/breath-cycle.ts），
 * 封缄走现役 sealLetter（session/handover-letter.ts）——全仓唯一实现纪律
 * （resident-runtime-write-surface）：这里只调用，不再造第二份。
 *
 * 触发线语义（D8 一 + 判卷口径）：
 * - `current` 当代生效的线；`pending` 主人改的线，**从下一代生效**——
 *   不给当前这一代续命。
 * - 窗自己只能在开工（本代还没有回合）时设线；回合起了再改 = breath-refused。
 * - 累积按 `estimateTokens`（handover-letter 的保守估算口径，同尺子量到底）；
 *   累积 ≥ current 就到线，由 say 在回合落账后换气。
 *
 * 信落 letters/ 目录，文件名 `<residentId>.letter-<generation>.json`——
 * 扫描面命名公约（全等 residentId 或 `residentId.` 开头）对它同样成立，
 * RT-06 的按户界扫描不会漏掉它。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LetterItemView,
  LetterTimeline,
  LetterView,
} from "../../acceptance/resident-runtime-driver.ts";
import type { LetterDraft, LetterItem, SealedLetter } from "../session/handover-letter.ts";

/** 触发线配置（成员级）。JSON 落盘，Infinity 不可 JSON——默认线用 MAX_SAFE_INTEGER 表示「够高」。 */
export interface BreathConfig {
  /** 当代生效的触发线（token）。没设过 = MAX_SAFE_INTEGER（不自动换气）。 */
  current: number;
  /** 主人改的线，从下一代生效；null = 没有待定改动。 */
  pending: number | null;
  /** 当代已累积的 token；换代清零。 */
  accumulated: number;
}

const DEFAULT_CONFIG: BreathConfig = {
  current: Number.MAX_SAFE_INTEGER,
  pending: null,
  accumulated: 0,
};

interface BreathStateFile {
  schemaVersion: 1;
  configs: Record<string, BreathConfig>;
}

/** 触发线状态面：读改写都过这里，落盘一次一份（临时写 → rename，与安装器同款纪律）。 */
export class BreathStateStore {
  readonly #path: string;
  readonly #configs = new Map<string, BreathConfig>();

  constructor(statePath: string) {
    this.#path = statePath;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as BreathStateFile;
      if (parsed.schemaVersion === 1 && typeof parsed.configs === "object") {
        for (const [residentId, config] of Object.entries(parsed.configs)) {
          this.#configs.set(residentId, { ...DEFAULT_CONFIG, ...config });
        }
      }
    } catch {
      // 文件不存在或坏了：从默认值起步。线是成员配置不是史——丢配置不丢史。
    }
  }

  configOf(residentId: string): BreathConfig {
    const config = this.#configs.get(residentId);
    if (config === undefined) return { ...DEFAULT_CONFIG };
    return config;
  }

  /** 改配置（调用方决定语义）；改完落盘。 */
  update(residentId: string, mutate: (config: BreathConfig) => void): BreathConfig {
    const config = { ...this.configOf(residentId) };
    mutate(config);
    this.#configs.set(residentId, config);
    this.#flush();
    return config;
  }

  /** 换代收尾：主人的待定线从下一代生效，累积清零。 */
  advanceGeneration(residentId: string): BreathConfig {
    return this.update(residentId, (config) => {
      if (config.pending !== null) {
        config.current = config.pending;
        config.pending = null;
      }
      config.accumulated = 0;
    });
  }

  #flush(): void {
    const payload: BreathStateFile = {
      schemaVersion: 1,
      configs: Object.fromEntries(this.#configs),
    };
    const temporary = `${this.#path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    // 临时写 → 原子 rename（安装器同款纪律）。配置文件无并发写方——宿主单进程单 writer。
    renameSync(temporary, this.#path);
  }
}

/** 交接信时间线：一户一目录，一代一封（RT-03「每代恰好一封」）。 */
export class LetterStore {
  readonly #dir: string;

  constructor(lettersDir: string) {
    this.#dir = lettersDir;
    mkdirSync(this.#dir, { recursive: true });
  }

  /** 信落时间线（BreathCycle 的 appendLetter 口）。落盘失败就抛——换代必须等耐久写回执。 */
  append(letter: SealedLetter): void {
    const path = join(this.#dir, letterPath(letter.residentId, letter.generation));
    writeFileSync(path, `${JSON.stringify(letter, null, 2)}\n`, "utf8");
  }

  /** 某户的全部信，按代际升序。 */
  timeline(residentId: string): SealedLetter[] {
    const prefix = `${residentId}.letter-`;
    const letters: SealedLetter[] = [];
    for (const file of readdirSync(this.#dir)) {
      // 按户界（命名公约）：r-a 的时间线不含 r-ab 的信。
      if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
      let parsed: SealedLetter;
      try {
        parsed = JSON.parse(readFileSync(join(this.#dir, file), "utf8")) as SealedLetter;
      } catch (error) {
        // fail-closed（协助审查）：信档损坏不许静默跳过——那会让「最新信损坏」
        // 误表现为「上一代信仍是最新」。报出来，让人来修档，不回退到旧信。
        throw new Error(`交接信档损坏：${file}（${(error as Error).message}）`);
      }
      if (
        typeof parsed.title !== "string" ||
        typeof parsed.residentId !== "string" ||
        typeof parsed.generation !== "number"
      ) {
        throw new Error(`交接信档不合形状：${file}`);
      }
      letters.push(parsed);
    }
    return letters.sort((a, b) => a.generation - b.generation);
  }

  /** 最近一代的信（启动包注入的就是它）；没换过代 = null。 */
  latest(residentId: string): SealedLetter | null {
    const letters = this.timeline(residentId);
    return letters[letters.length - 1] ?? null;
  }
}

function letterPath(residentId: string, generation: number): string {
  return `${residentId}.letter-${generation}.json`;
}

/** SealedLetter → 判卷契约的 LetterView（签名是换代前那代的 `${id}#${generation}`）。 */
export function toLetterView(letter: SealedLetter): LetterView {
  return {
    title: letter.title,
    author: `${letter.residentId}#${letter.generation}`,
    writtenAt: letter.sealedAt,
    state: letter.state.map(toItemView),
    intent: letter.intent.map(toItemView),
  };
}

function toItemView(item: LetterItem): LetterItemView {
  return { tier: item.tier, body: item.body };
}

/** letterShape 同族：时间线读口给判卷的视图序列。 */
export function toLetterTimeline(
  residentId: string,
  letters: readonly SealedLetter[],
): LetterTimeline {
  return { residentId, letters: letters.map(toLetterView) };
}

/**
 * 亲笔信草稿：从这**一**代自己的状态里写（承诺 = commitment 档、记忆/事实 = fact 档、
 * 接续判断 = judgment 档）。判卷明文「判结构不变量，不判信的内容」（D8 当刻亲笔），
 * 所以内容是确定性装配，不需要模型代笔——住户状态里的东西就是住户的笔迹。
 */
export function composeLetterDraft(input: {
  residentId: string;
  generation: number;
  commitments: readonly string[];
  memories: readonly string[];
  streamEvents: number;
}): LetterDraft {
  const state: LetterItem[] = [
    ...input.commitments.map((body): LetterItem => ({ tier: "commitment", body })),
    ...input.memories.map((body): LetterItem => ({ tier: "fact", body })),
    {
      tier: "fact",
      body: `本代一窗流共 ${input.streamEvents} 条事件，原样留底在归档里，不随信搬运。`,
    },
  ];
  const intent: LetterItem[] = [
    {
      tier: "judgment",
      body: "接续以本信为锚：承诺与事实看 state 半，原始流水按代归档可查、不自动进上下文。",
    },
  ];
  return {
    title: `第 ${input.generation} 代交接信（${input.residentId}）`,
    state,
    intent,
  };
}
