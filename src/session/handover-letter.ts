/**
 * 交接信 —— 换气的纵向连续性载体（图纸 docs/design/multi-viewport.md §4.2）。
 *
 * 本模块只管信这个**数据结构本身**：校验、封缄、盖亲笔章。信怎么被写、
 * 何时触发、落进哪条时间线、怎么随启动包注入，分别是换气状态机、
 * 时间线与装配器的地盘，不在这里。
 *
 * 三条不肯让步的判据，全部来自 D8 补记与 #66：
 *
 * 1. **标注单位是条目不是段落**（MV-D06）：`Item.tier` 一条只装一档，混档
 *    句必须在写的时候拆开。段落级标注让「这段大体是判断」把一句承诺捎带
 *    过去，继任者读到的是一坨语气，不是一条能执行的约束。
 * 2. **承诺的真源是账，信只是载体**（§4.2）：`commitment` 条目带 ledgerSeq
 *    指回账上那条裁定，不复印正文。因此**信里不存在「作废」这个动作**——
 *    解除承诺是往账上追加 supersede 条目，不是在新一代的信里给旧承诺打个
 *    标记。带作废意图的条目在这里被硬拒（MV-D06 后半），否则「继任者必须
 *    继承」会退化成「继任者可以宣布不继承」。
 * 3. **亲笔纪律只约束 intent 半**（§4.2 代价行）：state 半允许脚本生成，
 *    intent 半的每一条盖当刻的 author（residentId + generation）与写入时间。
 *    纪律铺太宽会精确压垮它最想保护的那部分。
 *
 * 失败一律抛可按名捕获的 LetterSchemaError，不返回「大概能用」的信：
 * 一封校验没过的信如果被放行，坏的不是这一封，是下一代醒来时对信的信任。
 */

export const LETTER_SCHEMA_INVALID = "LETTER_SCHEMA_INVALID" as const;

/** 三档语义见图纸 §4.2；顺序即严重度，不参与排序。 */
export type LetterTier = "commitment" | "fact" | "judgment";

const LETTER_TIERS: readonly LetterTier[] = ["commitment", "fact", "judgment"];

/**
 * 信的默认长度上限（图纸 §4.2：默认 2000 token，实现时校）。
 * 上限管的是全信——标题 + 两半的全部 body。
 */
export const DEFAULT_LETTER_TOKEN_LIMIT = 2000;

export class LetterSchemaError extends Error {
  readonly code = LETTER_SCHEMA_INVALID;
  constructor(reason: string) {
    super(`${LETTER_SCHEMA_INVALID}: ${reason}`);
    this.name = "LetterSchemaError";
  }
}

export interface LetterItem {
  tier: LetterTier;
  body: string;
  /**
   * 只有 commitment 档给：指回权威事实账上那条裁定的 seq（§4.2）。
   * 指针不复印条目正文——正文会漂，seq 不会。
   */
  ledgerSeq?: number;
}

/** 住户交上来的草稿：还没盖章，还没校验。 */
export interface LetterDraft {
  title: string;
  /** 状态半：做了什么、动了哪些文件、CI 状态。允许脚本生成。 */
  state: LetterItem[];
  /** 意图半：为什么选这条路、放弃了什么、此刻的状态。必须当刻亲笔。 */
  intent: LetterItem[];
}

/** intent 条目封缄后带上的当刻亲笔标记（MV-D06）。 */
export interface AuthorMark {
  /** `${residentId}#${generation}`——写下它的**那一代**，不是读它的那一代。 */
  author: string;
  /** 当刻写入时间，ISO-8601 UTC。由调用方给钟，模块内不读系统时间。 */
  writtenAt: string;
}

export type SealedIntentItem = LetterItem & AuthorMark;

/** 封缄后的信：可以落时间线、可以随启动包注入的那一份。 */
export interface SealedLetter {
  title: string;
  state: LetterItem[];
  intent: SealedIntentItem[];
  /** 写这封信的窗与代际。信是窗级 + 代级的东西，不是住户级的。 */
  windowId: string;
  residentId: string;
  generation: number;
  sealedAt: string;
}

export interface SealLetterContext {
  residentId: string;
  windowId: string;
  /** 写信的这一代（换气前的旧代），不是即将醒来的新代。 */
  generation: number;
  /** 当刻时间，ISO-8601 UTC。显式传入而不是模块内取——纯函数、可判卷。 */
  now: string;
  tokenLimit?: number;
  /**
   * 长度度量口。不给则用 estimateTokens（**保守估算，不是真 tokenizer**）。
   * 接了真 tokenizer 的宿主必须注入，否则 D08 的上限只是近似的——
   * 这个事实写在这里，好过让调用方以为 2000 是精确数。
   */
  measureTokens?: (text: string) => number;
}

/**
 * 粗估 token 数：CJK 按 1 字 1 token，其余按 4 字符 1 token 向上取整。
 *
 * 这是**估算**。真值取决于具体 tokenizer，本仓库不依赖任何 tokenizer 包，
 * 与其假装精确不如把近似写在名字和文档里：D08 要的是「超上限被拒且错误
 * 信息指明上限与实际」，估算口径下这条依然成立且可判卷；要精确的宿主注入
 * measureTokens 即可。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const char of text) {
    // 中日韩统一表意文字 + 常用标点段；漏掉的生僻段落只会让估算偏保守。
    if (/[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/.test(char)) {
      cjk += 1;
    } else {
      rest += 1;
    }
  }
  return cjk + Math.ceil(rest / 4);
}

/**
 * 校验并封缄一封草稿。通过则返回可落盘的 SealedLetter，否则抛
 * LetterSchemaError。校验顺序刻意是「结构 → 内容 → 长度」：长度错误信息
 * 最贵（要度量全信），先把结构性错误挑干净，报错才指得准。
 */
export function sealLetter(draft: LetterDraft, context: SealLetterContext): SealedLetter {
  assertTitle(draft.title);
  assertItems(draft.state, "state");
  assertItems(draft.intent, "intent");
  assertLength(draft, context);

  const author = formatAuthor(context.residentId, context.generation);
  return {
    title: draft.title.trim(),
    // 两半都做副本：调用方之后改草稿不该脏已封缄的信。
    state: draft.state.map((item) => ({ ...item })),
    intent: draft.intent.map((item) => ({ ...item, author, writtenAt: context.now })),
    windowId: context.windowId,
    residentId: context.residentId,
    generation: context.generation,
    sealedAt: context.now,
  };
}

/** author 的唯一构造口。判卷与实现共用同一个函数，格式漂了两边一起漂。 */
export function formatAuthor(residentId: string, generation: number): string {
  return `${residentId}#${generation}`;
}

/**
 * MV-D05 前半：标题必填。空标题的信被拒，因为时间线按标题切 chunk 做召回
 * 锚点——没有标题的信写进去就是一段查不回来的文本，比没写更坏（它占了
 * 「这一代有交接」的位置）。纯空白同样算没有。
 */
function assertTitle(title: unknown): void {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new LetterSchemaError("标题必填：时间线按标题切 chunk 做召回锚点，无标题的信不可召回");
  }
}

function assertItems(items: unknown, half: "state" | "intent"): void {
  if (!Array.isArray(items)) {
    throw new LetterSchemaError(`${half} 半必须是条目数组`);
  }
  items.forEach((item, index) => assertItem(item, half, index));
}

function assertItem(item: unknown, half: "state" | "intent", index: number): void {
  const at = `${half}[${index}]`;
  if (typeof item !== "object" || item === null) {
    throw new LetterSchemaError(`${at} 不是条目对象`);
  }
  const candidate = item as Partial<LetterItem> & Record<string, unknown>;
  if (typeof candidate.tier !== "string" || !LETTER_TIERS.includes(candidate.tier as LetterTier)) {
    throw new LetterSchemaError(
      `${at} 的 tier 必须是 ${LETTER_TIERS.join(" | ")} 之一，实际 ${String(candidate.tier)}`,
    );
  }
  if (typeof candidate.body !== "string" || candidate.body.trim().length === 0) {
    throw new LetterSchemaError(`${at} 的 body 不能为空`);
  }
  // 一条只装一档（MV-D06）：tier 是单值字段而不是数组，这是结构层的保证；
  // 这里补的是把多档塞进同一条的两种绕道写法。
  if (Array.isArray((candidate as { tiers?: unknown }).tiers)) {
    throw new LetterSchemaError(`${at} 出现 tiers 多档字段：一条只装一档，混档句必须拆开写`);
  }
  assertCommitmentShape(candidate, at);
}

/**
 * MV-D06 后半 —— 承诺在信里不可被作废。
 *
 * 判红的形状是「新一代在信里给继承来的 commitment 打个 revoked/void 标记，
 * 于是这条承诺在下一代的信里消失了，而账上什么都没发生」。信里没有作废
 * 动作可用，是因为承诺的真源在账上：解除走 supersede 追加（图纸 §3.1），
 * 那条路径有序号、有理由、有缺口传播，信这条路径一样都没有。
 *
 * 所以带作废意图的字段在这里硬拒而不是忽略：忽略等于让写信的一方以为
 * 自己解除成功了。
 */
function assertCommitmentShape(item: Record<string, unknown>, at: string): void {
  for (const field of ["revoked", "void", "superseded", "cancelled"]) {
    if (item[field] !== undefined) {
      throw new LetterSchemaError(
        `${at} 带作废标记 ${field}：承诺的真源是权威事实账，解除只能往账上追加 supersede 条目，信里不存在作废动作`,
      );
    }
  }
  if (item.tier !== "commitment") {
    if (item.ledgerSeq !== undefined) {
      throw new LetterSchemaError(`${at} 只有 commitment 档可带 ledgerSeq 指针`);
    }
    return;
  }
  if (item.ledgerSeq === undefined) {
    throw new LetterSchemaError(
      `${at} 是 commitment 档但缺 ledgerSeq：承诺的真源是账，信只带指针不复印正文`,
    );
  }
  if (typeof item.ledgerSeq !== "number" || !Number.isInteger(item.ledgerSeq)) {
    throw new LetterSchemaError(`${at} 的 ledgerSeq 必须是整数 seq`);
  }
}

/**
 * MV-D08：超上限被拒，错误信息必须同时指明上限值与当前实际长度——
 * 只说「太长了」的错误会让写信的一代删到猜为止，而写信发生在临线时刻，
 * 那是最没有余量做二分查找的时候。
 */
function assertLength(draft: LetterDraft, context: SealLetterContext): void {
  const limit = context.tokenLimit ?? DEFAULT_LETTER_TOKEN_LIMIT;
  const measure = context.measureTokens ?? estimateTokens;
  const bodies = [
    draft.title,
    ...draft.state.map((i) => i.body),
    ...draft.intent.map((i) => i.body),
  ];
  const actual = bodies.reduce((sum, text) => sum + measure(text), 0);
  if (actual > limit) {
    throw new LetterSchemaError(`信超长：上限 ${limit} token，当前 ${actual} token`);
  }
}
