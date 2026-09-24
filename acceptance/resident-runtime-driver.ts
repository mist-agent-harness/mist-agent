/**
 * #194（RT-01～RT-07）的验收驱动契约。
 *
 * 判卷只通过本接口观察住户运行时，不 import `src/` 实现。实现方在
 * `src/resident-runtime-acceptance-driver.ts` 导出 `createResidentRuntimeDriver()`；
 * 驱动缺失时七盏灯全部保持红色——那是判卷先行的起点，不是故障。
 *
 * 判卷对象是 D28 那条最小闭环：醒来（读启动包 + 真实对话往返）、写流（一窗流唯一
 * writer）、换代（亲笔交接信）、通道（D25 订阅 / API key）、TUI、凭证、真源。
 * 住户真源归 mist——一窗流唯一 writer（D9）、交接信换代（D8）、启动包与事实账都用
 * `src/` 里已有的实现。实现路线（mist 当宿主还是 pi 扩展）不在本契约里预设，但
 * 「不在 pi 里另起一份副本」两条路线都适用，RT-07 对两条路线同样判。
 *
 * 判卷纪律照 `acceptance/README.md`：只做确定性断言——比字节、比序号、比内容 hash、
 * 比结构化错误与真实副作用。**不判回复的措辞**：「醒来还是同一个人」翻译成
 * 「启动包与一窗流逐字可读回」，不翻译成「聊起来像不像」。
 */

/** 判卷自带的最小 JSON 视图：acceptance 树不 import `src/` 的类型。 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * 结构化失败码。RT-01 要求「没配凭证」与「凭证失效」机器可分，且都必须给出
 * 可操作提示，所以失败分支带判据而不是一句自由文本。
 */
export type ResidentRuntimeErrorCode =
  /** 从未配过凭证：安装器里查无此住户的凭证条目。 */
  | "credential-missing"
  /** 凭证在但失效：过期、被吊销、被上游拒认。 */
  | "credential-invalid"
  /** 通道跑不起来：pi-claude-bridge / pi-ai 扩展没装或起不来。 */
  | "channel-unavailable"
  /** 住户不存在。 */
  | "resident-not-found"
  /** 这条一窗流不存在（区别于「流是空的」）。 */
  | "stream-not-found"
  /** 唯一 writer 不可用（宿主未起、写句柄已交还）。 */
  | "writer-unavailable"
  /** 换气被拒：临线改阈值、不写信就想换代、代际不对。 */
  | "breath-refused"
  /** 交接信不合模板：缺标题、超长度上限、tier 非法。 */
  | "letter-invalid"
  /** TUI 起不来或脚本跑不完。 */
  | "tui-unavailable";

export interface ResidentRuntimeError {
  readonly code: ResidentRuntimeErrorCode;
  readonly message: string;
  /**
   * 可操作提示。RT-01 明文要求「给出可操作提示，不静默」——空串即判红。
   * 判据是**非空且指到具体动作**，不是「读起来贴心」。
   */
  readonly remedy: string;
  readonly residentId: string | null;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResidentRuntimeError };

// —— 宿主进程 ——

/**
 * 真实宿主进程身份。`pid` 与 `bootId` 让判卷能断言「确实换了一个进程」；
 * `dataDir` 让判卷能直接 stat 真实落盘目录取证据，不收内存替身。
 */
export interface HostDescriptor {
  readonly pid: number;
  /** 每次启动唯一；重启后必须与上一次不同。 */
  readonly bootId: string;
  /** 真实落盘根目录的绝对路径。 */
  readonly dataDir: string;
}

// —— 通道（D25） ——

/** 密钥来源：订阅与 API key 并列一等（D25 一），不分主次。 */
export type CredentialKind = "subscription" | "api-key";

/**
 * 通道实现。D25 三：**Claude 订阅是唯一特例**，走 pi-claude-bridge；其余经 pi-ai。
 * 这个映射本身就是 RT-04 的判据之一，接反了判红。
 */
export type ChannelAdapter = "pi-claude-bridge" | "pi-ai";

export interface ChannelSpec {
  /** 是否 Claude 订阅。true 时 `credentialKind` 必须是 `subscription`。 */
  readonly claudeSubscription: boolean;
  readonly credentialKind: CredentialKind;
  /** 模型标识，原样进 TUI 状态栏（RT-05）。 */
  readonly model: string;
}

export interface ChannelRoute {
  readonly adapterId: ChannelAdapter;
  readonly credentialKind: CredentialKind;
  readonly model: string;
}

export interface ProvisionedChannel extends ChannelRoute {
  /**
   * 凭证**引用**，不是明文。RT-06 要求密钥只走环境变量或凭证引用；
   * 这个字段的值不许等于密钥字面量本身。
   */
  readonly credentialRef: string;
}

// —— 对话往返 ——

export interface TurnResult {
  readonly residentId: string;
  readonly model: string;
  /** 本次回复落在第几代。 */
  readonly generation: number;
  readonly reply: string;
  /** 是否流式产出（RT-05 的正对照）。 */
  readonly streamed: boolean;
}

// —— 一窗流只读 ——

export interface StreamEventView {
  readonly eventId: string;
  /** 底座发号，调用方没有传入 seq 的入口。 */
  readonly streamSeq: number;
  readonly kind: "user" | "assistant";
  readonly text: string;
  readonly payloadHash: string;
}

export interface StreamSnapshot {
  readonly residentId: string;
  /** 按 `streamSeq` 升序。 */
  readonly events: readonly StreamEventView[];
}

/**
 * 一窗流的落盘文件清单。RT-02「不出现第二条会话」的机器形式就是它——
 * 一位住户的 canonical stream 落盘文件恰好一个，多一个就是长了第二条生命线。
 */
export interface StreamFileInventory {
  readonly files: readonly string[];
}

// —— 启动包与交接信 ——

export interface MemoryEntryView {
  readonly id: string;
  readonly content: string;
  readonly supersededBy: string | null;
}

/** 交接信条目三档（D8 补记三）：承诺与生效中的约束 / 事实与状态 / 判断与意图。 */
export type LetterTier = "commitment" | "fact" | "judgment";

export interface LetterItemView {
  readonly tier: LetterTier;
  readonly body: string;
}

/**
 * 一封亲笔交接信。`author` 是签名，形如 `` `${residentId}#${generation}` ``，
 * 其中 generation 是**写下这封信的那一代**（换代前那代）——代际对不上就是冒署。
 */
export interface LetterView {
  readonly title: string;
  readonly author: string;
  readonly writtenAt: string;
  readonly state: readonly LetterItemView[];
  readonly intent: readonly LetterItemView[];
}

export interface LetterTimeline {
  readonly residentId: string;
  /** 按时间升序，一代一封。 */
  readonly letters: readonly LetterView[];
}

export interface BootPackView {
  readonly residentId: string;
  readonly identity: string;
  readonly commitments: readonly string[];
  readonly memories: readonly MemoryEntryView[];
  /**
   * 随启动包注入的交接信（D8 补记三：醒来即已读，不让住户再发一次工具调用去读）。
   * 最近一代的信；没有换过代时为 null。
   */
  readonly letter: LetterView | null;
}

// —— 换气（D8） ——

export type BreathTrigger = "new" | "clear" | "compact";

export interface BreatheOutcome {
  readonly fromGeneration: number;
  readonly toGeneration: number;
  /** 换气前后逐字不变（RT-03 / MV-D10 同族）。 */
  readonly windowId: string;
  readonly letter: LetterView;
}

// —— TUI ——

/** 一帧画面。`sessionCount` 是画面里出现的会话个数——D9 要求恒为 1，没有会话列表。 */
export interface TuiFrame {
  readonly atMs: number;
  /** 累积可见区的纯文本。 */
  readonly text: string;
  readonly sessionCount: number;
}

export interface TuiTranscript {
  readonly frames: readonly TuiFrame[];
  /** 状态栏里的住户标识；看不到就 null，判红。 */
  readonly statusResidentId: string | null;
  /** 状态栏里的模型标识；看不到就 null，判红。 */
  readonly statusModel: string | null;
  /** 流式回复被切成的增量片段；长度 < 2 说明不是流式吐出。 */
  readonly streamChunks: readonly string[];
  /** 画面里出现的错误文本；出错却为 null 就是静默失败。 */
  readonly errorText: string | null;
}

/** TUI 脚本步骤：敲一行、等回复、或注入一次故障看错误呈现。 */
export type TuiStep =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "breakChannel" }
  | { readonly kind: "input-after-break"; readonly text: string };

// —— 凭证扫描 ——

export interface SecretHit {
  /** 哪个面上漏了：`log` / `stream` / `letter` / `bootpack`。 */
  readonly surface: string;
  /** 命中的字面量。判卷自带 canary 或正对照针，不取真实密钥。 */
  readonly needle: string;
}

export interface SecretScanReport {
  readonly hits: readonly SecretHit[];
}

export interface ResidentRuntimeDriver {
  /** 每盏灯后清掉合成住户、通道、落盘目录与注入的故障。 */
  reset(): Promise<void>;

  // —— 真实宿主：起得来、杀得死、拉得起 ——
  startHost(): Promise<HostDescriptor>;
  /** 硬杀宿主进程，不给优雅 flush 的机会。 */
  killHost(): Promise<void>;
  hostDescriptor(): Promise<HostDescriptor>;

  // —— 通道（D25） ——
  /**
   * 按安装器的方式配一条通道。`canarySecret` 是判卷自带的蜜罐密钥，
   * 实现必须把它当真实密钥走完整条凭证路径（RT-06 才有意义）。
   */
  provisionChannel(input: {
    residentId: string;
    channel: ChannelSpec;
    canarySecret: string;
  }): Promise<Result<ProvisionedChannel>>;
  /** 让已配凭证失效（过期 / 吊销），用于 RT-01 的第二个失败分支。 */
  revokeCredential(input: { residentId: string }): Promise<void>;
  /** 只算路由不落凭证：RT-04 判 D25 三的适配器映射。 */
  resolveChannelRoute(input: { channel: ChannelSpec }): Promise<Result<ChannelRoute>>;

  // —— 对话往返 ——
  say(input: { residentId: string; text: string }): Promise<Result<TurnResult>>;

  // —— 一窗流只读 ——
  readStream(input: { residentId: string }): Promise<Result<StreamSnapshot>>;
  streamFiles(): Promise<Result<StreamFileInventory>>;

  // —— 启动包与交接信 ——
  bootPack(input: { residentId: string }): Promise<Result<BootPackView>>;
  letterTimeline(input: { residentId: string }): Promise<Result<LetterTimeline>>;

  // —— 换气（D8） ——
  /**
   * 设触发线（D8 一：成员级配置，只能在窗开工时设定）。
   *
   * `authority` 分清是谁在改，因为 D8 禁的只是**窗给自己续命**，不是主人不能改配置：
   * - `window` —— 这扇窗改自己的线。窗已开工就 fail-closed 拒绝、返回 `breath-refused`
   *   （D8 明文「临近红线的窗无权给自己续命」；D8 补记一「跑没跑完的判断权在账侧，
   *   临线的窗无权自判」）。
   * - `owner` —— 主人改成员配置。允许，但**从下一代生效**，不给当前这一代续命。
   */
  setBreathThreshold(input: {
    residentId: string;
    windowId: string;
    generation: number;
    thresholdTokens: number;
    authority: "window" | "owner";
  }): Promise<Result<void>>;
  /** 走 D8 的统一流程：住户亲笔写信 → 换代重生。三个入口同义。 */
  breathe(input: {
    residentId: string;
    via: BreathTrigger;
  }): Promise<Result<BreatheOutcome>>;
  /** 猝死：没来得及写信就杀。用于判「原始流水不自动进继任者上下文」。 */
  suddenDeath(input: { residentId: string }): Promise<void>;

  // —— TUI ——
  tuiTranscript(input: {
    residentId: string;
    channel: ChannelSpec;
    script: readonly TuiStep[];
  }): Promise<Result<TuiTranscript>>;

  // —— 静态审计的检索根（RT-07） ——
  /**
   * 追加检索根：走 pi 扩展那条路线时把扩展目录报上来。判卷**永远至少检索**
   * 仓内 `src/`，这个方法只能加根、不能减——把第二份写入路径藏进扩展目录里
   * 照样被 RT-07 抓到。报不出扩展目录就不追加；不追加不会让灯变绿。
   */
  auditRoots(): Promise<readonly string[]>;

  // —— 凭证扫描 ——
  /**
   * 扫描字面量有没有漏进 日志 / 一窗流 / 交接信 / 启动包。
   * `needle` 由判卷指定，这样 RT-06 能先拿一段确定存在的文本做正对照——
   * 否则一个恒返回空 `hits` 的扫描器也能点绿。
   */
  secretScan(input: { residentId: string; needle: string }): Promise<Result<SecretScanReport>>;
}

/**
 * D27 三：判卷在驱动边界统一深拷贝入参与返回值，一次消掉别名类问题，
 * 不在每个调用点逐一冻结。
 *
 * 验收灯面向**非对抗驱动**：假定驱动如实回读自己的状态。这层代理挡的是
 * 「无心写成别名」，不是「存心在两次观察之间作弊」——后者归代码评审与验收席。
 */
export function cloneResidentRuntimeDriverBoundary(
  driver: ResidentRuntimeDriver,
): ResidentRuntimeDriver {
  return new Proxy(driver, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, structuredClone(args));
        return structuredClone(result);
      };
    },
  });
}

export interface ResidentRuntimeCheckResult {
  readonly passed: boolean;
  readonly detail: string;
}

export interface ResidentRuntimeCheck {
  readonly id: string;
  readonly title: string;
  /**
   * 本灯用到的驱动方法，供 runner 对照 `STUBBED` 名单判桩灯。
   * RT-07 的审计本体是静态的（读源码文本），只借 `auditRoots` 决定去哪找；
   * `src/` 永远在检索范围内，这个方法只能加根、不能减。
   */
  readonly uses: readonly (keyof ResidentRuntimeDriver)[];
  run(driver: ResidentRuntimeDriver): Promise<ResidentRuntimeCheckResult>;
}
