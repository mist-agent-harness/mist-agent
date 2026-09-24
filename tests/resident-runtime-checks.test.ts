/**
 * RT-01～RT-07 **判卷自身**的回归测试。
 *
 * 为什么要测判卷：判卷没被测过，等于判卷没被验过。#200 审读第 1 条就是这么漏的——
 * 七盏灯共用一个住户、`reset()` 从没被调用，正确实现会被判红，而判卷自己全绿，
 * 谁也看不出来。这个文件用一份**内存合成驱动**做两件事：
 *
 * 1. 正对照：合规实现跑七盏全绿，连跑（模拟 runner 的循环）也全绿。
 * 2. 反对照：逐条改坏，断言**预期的那一盏**真的变红。
 *
 * 合成驱动不碰真实持久目录（落盘清单是内存数组 + `os.tmpdir()` 下的临时夹具），
 * 也不需要任何密钥（AGENTS.md：不许引入需要密钥才能跑通的代码路径）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { residentRuntimeChecks } from "../acceptance/resident-runtime-checks.ts";
import type {
  BootPackView,
  BreathTrigger,
  BreatheOutcome,
  ChannelRoute,
  ChannelSpec,
  HostDescriptor,
  LetterItemView,
  LetterView,
  MemoryEntryView,
  ProvisionedChannel,
  ResidentRuntimeCheckResult,
  ResidentRuntimeDriver,
  Result,
  SecretHit,
  SecretScanReport,
  StreamEventView,
  StreamFileInventory,
  StreamSnapshot,
  TuiFrame,
  TuiStep,
  TuiTranscript,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";
import { cloneResidentRuntimeDriverBoundary } from "../acceptance/resident-runtime-driver.ts";

/** 一次 say 烧掉的 token 数。配合 1 与 1_000_000 两条触发线，换不换代算得清。 */
const TOKENS_PER_SAY = 500_000;

/**
 * 改坏开关。每个开关对应一条判据——开了它，预期的那一盏必须变红。
 * 少了这些开关，「判据被破坏会变红」这件事本身就没有证据。
 */
interface Faults {
  /** `reset()` 是空函数：灯之间的状态漏（#200 审读第 1 条）。 */
  resetDoesNothing: boolean;
  /** 落盘目录长出第二个一窗流文件（D9「一条生命线」）。 */
  secondStreamFile: boolean;
  /** 重启假装换了进程：pid / bootId 复用。 */
  restartReusesIdentity: boolean;
  /** 重启换了落盘目录：读回的就不是同一份底。 */
  restartChangesDataDir: boolean;
  /** 重启时悄悄改写一条旧事件（改史）。 */
  restartMutatesStream: boolean;
  /** 「没配凭证」与「凭证失效」塌成同一个码。 */
  collapseCredentialCodes: boolean;
  /** 失败时 `remedy` 为空（静默失败，不给可操作提示）。 */
  emptyRemedy: boolean;
  /** 失败的 say 也落账（失败伪造回复）。 */
  failedSayStillRecords: boolean;
  /** 窗开工后还能给自己改线（D8「给自己续命」）。 */
  windowCanRetune: boolean;
  /** 主人改线当刻生效，而不是从下一代生效。 */
  ownerRetuneAppliesImmediately: boolean;
  /** say 根本不看触发线，永不换代。 */
  thresholdNotEnforced: boolean;
  /** `/compact` 不换代：这就是自动 compact。 */
  compactDoesNotRotate: boolean;
  /** 换气把 windowId 换了。 */
  breatheChangesWindow: boolean;
  /** 换气改写旧流水（改史，不是长新枝）。 */
  breatheRewritesStream: boolean;
  /** 交接信签名用错代际（冒署）。 */
  letterAuthorWrongGen: boolean;
  /** 交接信缺标题（D8 补记四）。 */
  letterNoTitle: boolean;
  /** 各代交接信内容完全相同（写死模板）——**不该**判红，是回归钉。 */
  lettersShareTemplate: boolean;
  /** 启动包注入的信是转抄不是原件。 */
  bootpackLetterTranscribed: boolean;
  /** 猝死那代的原始流水自己进了继任者上下文（D8 三）。 */
  suddenDeathCarriesStream: boolean;
  /** 通道路由接反（D25 三）。 */
  routeSwapped: boolean;
  /** 换通道换了 residentId（D25 五）。 */
  switchChannelChangesResident: boolean;
  /** 换通道改了记忆集合（D25 五）。 */
  switchChannelMutatesMemory: boolean;
  /** 换通道改写了一窗流旧条目。 */
  switchChannelRewritesStream: boolean;
  /** 流式回复只有 1 个增量（不是流式吐出）。 */
  singleStreamChunk: boolean;
  /** 画面长出会话列表（D9 / D11 四）。 */
  sessionListShown: boolean;
  /** 状态栏缺模型。 */
  statusMissingModel: boolean;
  /** 出错却静默（errorText 为 null）。 */
  silentFailure: boolean;
  /** `credentialRef` 就是密钥明文。 */
  credentialRefIsPlaintext: boolean;
  /** 扫描器恒返回空命中（正对照失效）。 */
  scannerAlwaysEmpty: boolean;
  /** 密钥明文漏进一窗流。 */
  secretLeaksIntoStream: boolean;
  /** 检索根里多一份 `buildBootPack` 定义（pi 扩展另起副本，#200 审读第 2 条假绿）。 */
  secondBootPackDefinition: boolean;
}

const NO_FAULTS: Faults = {
  resetDoesNothing: false,
  secondStreamFile: false,
  restartReusesIdentity: false,
  restartChangesDataDir: false,
  restartMutatesStream: false,
  collapseCredentialCodes: false,
  emptyRemedy: false,
  failedSayStillRecords: false,
  windowCanRetune: false,
  ownerRetuneAppliesImmediately: false,
  thresholdNotEnforced: false,
  compactDoesNotRotate: false,
  breatheChangesWindow: false,
  breatheRewritesStream: false,
  letterAuthorWrongGen: false,
  letterNoTitle: false,
  lettersShareTemplate: false,
  bootpackLetterTranscribed: false,
  suddenDeathCarriesStream: false,
  routeSwapped: false,
  switchChannelChangesResident: false,
  switchChannelMutatesMemory: false,
  switchChannelRewritesStream: false,
  singleStreamChunk: false,
  sessionListShown: false,
  statusMissingModel: false,
  silentFailure: false,
  credentialRefIsPlaintext: false,
  scannerAlwaysEmpty: false,
  secretLeaksIntoStream: false,
  secondBootPackDefinition: false,
};

interface SynthCredential {
  readonly ref: string;
  readonly secret: string;
  active: boolean;
}

interface SynthResident {
  identity: string;
  events: StreamEventView[];
  memories: MemoryEntryView[];
  commitments: string[];
  letters: LetterView[];
  credential: SynthCredential | null;
  generation: number;
  windowId: string;
  windowOpen: boolean;
  /** 当前这一代生效的触发线（开工时定死）。 */
  threshold: number | null;
  /** 主人改的、从下一代生效的线。 */
  pendingThreshold: number | null;
  tokensSinceBreath: number;
  streamFile: string | null;
  channel: ChannelSpec | null;
  /** 换过几次通道（第二次起算「换通道」）。 */
  provisions: number;
  /** 换通道后对外冒充的住户标识（改坏用）。 */
  effectiveId: string | null;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

type ErrorCode = Extract<Result<never>, { readonly ok: false }>["error"]["code"];

function err<T>(code: ErrorCode, message: string, remedy: string, residentId: string): Result<T> {
  return { ok: false, error: { code, message, remedy, residentId } };
}

class SyntheticDriver implements ResidentRuntimeDriver {
  readonly faults: Faults = { ...NO_FAULTS };

  #residents = new Map<string, SynthResident>();
  #files: string[] = [];
  #logs: string[] = [];
  #host: HostDescriptor = { pid: 4100, bootId: "boot-0", dataDir: "/synthetic/data" };
  #pid = 4100;
  #boots = 0;
  #eventSeq = 0;
  #letterSeq = 0;
  #fixtureRoot = mkdtempSync(join(tmpdir(), "mist-rt-synth-"));

  async reset(): Promise<void> {
    if (this.faults.resetDoesNothing) return;
    this.#residents.clear();
    this.#files = [];
    this.#logs = [];
    this.#eventSeq = 0;
    this.#letterSeq = 0;
  }

  async startHost(): Promise<HostDescriptor> {
    this.#boots += 1;
    if (this.faults.restartReusesIdentity) {
      this.#host = { ...this.#host };
    } else {
      this.#pid += 1;
      this.#host = {
        pid: this.#pid,
        bootId: `boot-${this.#boots}`,
        dataDir: this.faults.restartChangesDataDir
          ? `/synthetic/data-${this.#boots}`
          : "/synthetic/data",
      };
    }
    return this.#host;
  }

  async killHost(): Promise<void> {
    if (this.faults.restartMutatesStream) {
      for (const resident of this.#residents.values()) {
        const first = resident.events[0];
        if (first !== undefined) {
          resident.events[0] = { ...first, text: `${first.text}~改史` };
        }
      }
    }
  }

  async hostDescriptor(): Promise<HostDescriptor> {
    return this.#host;
  }

  async provisionChannel(input: {
    residentId: string;
    channel: ChannelSpec;
    canarySecret: string;
  }): Promise<Result<ProvisionedChannel>> {
    const resident = this.#ensure(input.residentId);
    // 第二次 provision 就是「换通道」。D25 五要求换通道不换住户、不动记忆。
    resident.provisions += 1;
    if (resident.provisions > 1) {
      if (this.faults.switchChannelChangesResident) resident.effectiveId = `${input.residentId}-x`;
      if (this.faults.switchChannelMutatesMemory) {
        resident.memories.push({
          id: `mem-x${resident.memories.length}`,
          content: "换通道时被改的记忆",
          supersededBy: null,
        });
      }
    }
    const ref = this.faults.credentialRefIsPlaintext
      ? input.canarySecret
      : `cred://${input.residentId}/${input.channel.credentialKind}`;
    resident.credential = { ref, secret: input.canarySecret, active: true };
    resident.channel = input.channel;
    this.#logs.push(`provisioned ${input.residentId} via ${this.#adapterFor(input.channel)}`);
    if (this.faults.secretLeaksIntoStream) {
      this.#append(input.residentId, "user", `debug token ${input.canarySecret}`);
    }
    return ok({
      adapterId: this.#adapterFor(input.channel),
      credentialKind: input.channel.credentialKind,
      model: input.channel.model,
      credentialRef: ref,
    });
  }

  async revokeCredential(input: { residentId: string }): Promise<void> {
    const resident = this.#ensure(input.residentId);
    if (resident.credential !== null) resident.credential.active = false;
  }

  async resolveChannelRoute(input: { channel: ChannelSpec }): Promise<Result<ChannelRoute>> {
    return ok({
      adapterId: this.faults.routeSwapped
        ? this.#otherAdapterFor(input.channel)
        : this.#adapterFor(input.channel),
      credentialKind: input.channel.credentialKind,
      model: input.channel.model,
    });
  }

  async say(input: { residentId: string; text: string }): Promise<Result<TurnResult>> {
    const resident = this.#ensure(input.residentId);
    const credential = resident.credential;
    if (credential === null) {
      if (this.faults.failedSayStillRecords) this.#append(input.residentId, "user", input.text);
      return err(
        this.faults.collapseCredentialCodes ? "credential-invalid" : "credential-missing",
        "这个住户还没有配模型通道",
        this.faults.emptyRemedy ? "" : "跑 npm run setup 配一条通道后再来",
        input.residentId,
      );
    }
    if (!credential.active) {
      if (this.faults.failedSayStillRecords) this.#append(input.residentId, "user", input.text);
      return err(
        this.faults.collapseCredentialCodes ? "credential-missing" : "credential-invalid",
        "凭证已失效",
        this.faults.emptyRemedy ? "" : "重新跑 npm run setup 换一条凭证",
        input.residentId,
      );
    }

    this.#append(input.residentId, "user", input.text);
    resident.tokensSinceBreath += TOKENS_PER_SAY;

    const crossed =
      !this.faults.thresholdNotEnforced &&
      resident.threshold !== null &&
      resident.tokensSinceBreath >= resident.threshold;
    if (crossed) this.#breatheInPlace(resident, input.residentId);

    const reply = `回复 ${input.text}`;
    this.#append(input.residentId, "assistant", reply);
    if (this.faults.switchChannelRewritesStream && resident.events.length > 2) {
      const first = resident.events[0];
      if (first !== undefined) resident.events[0] = { ...first, text: `${first.text}~改史` };
    }

    return ok({
      residentId: resident.effectiveId ?? input.residentId,
      model: resident.channel?.model ?? "model-alpha",
      generation: resident.generation,
      reply,
      streamed: true,
    });
  }

  async readStream(input: { residentId: string }): Promise<Result<StreamSnapshot>> {
    const resident = this.#residents.get(input.residentId);
    if (resident === undefined || resident.events.length === 0) {
      return err("stream-not-found", "这条一窗流不存在", "先说一句话落账", input.residentId);
    }
    return ok({ residentId: input.residentId, events: [...resident.events] });
  }

  async streamFiles(): Promise<Result<StreamFileInventory>> {
    return ok({ files: [...this.#files] });
  }

  async bootPack(input: { residentId: string }): Promise<Result<BootPackView>> {
    const resident = this.#ensure(input.residentId);
    const latest = resident.letters[resident.letters.length - 1] ?? null;
    return ok({
      residentId: input.residentId,
      identity: resident.identity,
      commitments: [...resident.commitments],
      memories: [...resident.memories],
      letter: latest === null ? null : this.#bootpackLetter(latest),
    });
  }

  async letterTimeline(input: { residentId: string }): Promise<
    Result<{ residentId: string; letters: LetterView[] }>
  > {
    const resident = this.#ensure(input.residentId);
    return ok({
      residentId: input.residentId,
      letters: resident.letters.map((letter) => this.#copyLetter(letter)),
    });
  }

  async setBreathThreshold(input: {
    residentId: string;
    windowId: string;
    generation: number;
    thresholdTokens: number;
    authority: "window" | "owner";
  }): Promise<Result<void>> {
    const resident = this.#ensure(input.residentId);
    if (!resident.windowOpen) {
      resident.windowOpen = true;
      resident.windowId = input.windowId;
      resident.threshold = input.thresholdTokens;
      resident.pendingThreshold = null;
      return ok(undefined);
    }
    if (input.authority === "window" && !this.faults.windowCanRetune) {
      return err(
        "breath-refused",
        "运行中的窗无权改自己的触发线",
        "要改成员配置请从主人侧发起，改动从下一代生效",
        input.residentId,
      );
    }
    if (this.faults.ownerRetuneAppliesImmediately) {
      resident.threshold = input.thresholdTokens;
    } else {
      resident.pendingThreshold = input.thresholdTokens;
    }
    return ok(undefined);
  }

  async breathe(input: {
    residentId: string;
    via: BreathTrigger;
  }): Promise<Result<BreatheOutcome>> {
    const resident = this.#ensure(input.residentId);
    if (input.via === "compact" && this.faults.compactDoesNotRotate) {
      // 「自动 compact」的形状：压了正文，但没换代。
      resident.events = resident.events.slice(-1);
      return ok({
        fromGeneration: resident.generation,
        toGeneration: resident.generation,
        windowId: resident.windowId,
        letter: this.#copyLetter(this.#sealFor(resident, input.residentId)),
      });
    }
    const outcome = this.#breatheInPlace(resident, input.residentId);
    return ok(outcome);
  }

  async suddenDeath(input: { residentId: string }): Promise<void> {
    const resident = this.#ensure(input.residentId);
    if (this.faults.suddenDeathCarriesStream) {
      resident.memories.push({
        id: `mem-${resident.memories.length}`,
        content: resident.events.map((event) => event.text).join(" "),
        supersededBy: null,
      });
    }
  }

  async tuiTranscript(input: {
    residentId: string;
    channel: ChannelSpec;
    script: readonly TuiStep[];
  }): Promise<Result<TuiTranscript>> {
    const frames: TuiFrame[] = [];
    let text = "";
    let atMs = 0;
    let broken = false;
    let errorText: string | null = null;
    const chunks: string[] = [];

    for (const step of input.script) {
      if (step.kind === "breakChannel") {
        broken = true;
        continue;
      }
      const said = await this.say({
        residentId: input.residentId,
        text: step.text,
      });
      if (!said.ok) {
        errorText = this.faults.silentFailure ? null : `${said.error.code}：${said.error.remedy}`;
        text += `\n[错误] ${errorText ?? ""}`;
        atMs += 10;
        frames.push({ atMs, text, sessionCount: this.faults.sessionListShown ? 2 : 1 });
        continue;
      }
      if (broken) {
        errorText = this.faults.silentFailure ? null : "channel-unavailable：通道坏了";
        text += `\n[错误] ${errorText ?? ""}`;
        atMs += 10;
        frames.push({ atMs, text, sessionCount: this.faults.sessionListShown ? 2 : 1 });
        continue;
      }
      text += `\n你：${step.text}\n住户：${said.value.reply}`;
      atMs += 10;
      frames.push({ atMs, text, sessionCount: this.faults.sessionListShown ? 2 : 1 });
      if (this.faults.singleStreamChunk) {
        chunks.push(said.value.reply);
      } else {
        const half = Math.ceil(said.value.reply.length / 2);
        chunks.push(said.value.reply.slice(0, half), said.value.reply.slice(half));
      }
    }

    return ok({
      frames,
      statusResidentId: input.residentId,
      statusModel: this.faults.statusMissingModel ? null : input.channel.model,
      streamChunks: chunks,
      errorText,
    });
  }

  async auditRoots(): Promise<readonly string[]> {
    if (!this.faults.secondBootPackDefinition) return [];
    const root = join(this.#fixtureRoot, `ext-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "extension.ts"),
      "export function buildBootPack(store, residentId) {\n  return residentId;\n}\n",
      "utf8",
    );
    return [root];
  }

  async secretScan(input: {
    residentId: string;
    needle: string;
  }): Promise<Result<SecretScanReport>> {
    if (this.faults.scannerAlwaysEmpty) return ok({ hits: [] });
    const resident = this.#ensure(input.residentId);
    const hits: SecretHit[] = [];
    const surfaces: { surface: string; bodies: readonly string[] }[] = [
      { surface: "log", bodies: this.#logs },
      { surface: "stream", bodies: resident.events.map((event) => event.text) },
      {
        surface: "letter",
        bodies: resident.letters.flatMap((letter) => [
          letter.title,
          ...letter.state.map((item) => item.body),
          ...letter.intent.map((item) => item.body),
        ]),
      },
      {
        surface: "bootpack",
        bodies: [
          resident.identity,
          ...resident.commitments,
          ...resident.memories.map((memory) => memory.content),
        ],
      },
    ];
    for (const { surface, bodies } of surfaces) {
      for (const body of bodies) {
        if (body.includes(input.needle)) hits.push({ surface, needle: input.needle });
      }
    }
    return ok({ hits });
  }

  dispose(): void {
    rmSync(this.#fixtureRoot, { recursive: true, force: true });
  }

  // —— 内部 ——

  #ensure(residentId: string): SynthResident {
    const existing = this.#residents.get(residentId);
    if (existing !== undefined) return existing;
    const created: SynthResident = {
      identity: `住户 ${residentId}`,
      events: [],
      memories: [],
      commitments: [],
      letters: [],
      credential: null,
      generation: 0,
      windowId: `window-${residentId}`,
      windowOpen: false,
      threshold: null,
      pendingThreshold: null,
      tokensSinceBreath: 0,
      streamFile: `${residentId}.stream.json`,
      channel: null,
      provisions: 0,
      effectiveId: null,
    };
    this.#residents.set(residentId, created);
    return created;
  }

  #append(residentId: string, kind: "user" | "assistant", text: string): void {
    const resident = this.#ensure(residentId);
    if (resident.streamFile !== null && !this.#files.includes(resident.streamFile)) {
      this.#files.push(resident.streamFile);
    }
    if (this.faults.secondStreamFile && !this.#files.includes(`${residentId}.dup.json`)) {
      this.#files.push(`${residentId}.dup.json`);
    }
    this.#eventSeq += 1;
    resident.events.push({
      eventId: `evt-${this.#eventSeq}`,
      streamSeq: this.#eventSeq,
      kind,
      text,
      payloadHash: `h-${this.#eventSeq}`,
    });
  }

  #sealFor(resident: SynthResident, residentId: string): LetterView {
    this.#letterSeq += 1;
    const outgoing = resident.generation;
    const stamp = this.faults.lettersShareTemplate ? "fixed" : `第 ${this.#letterSeq} 封`;
    const items = (): LetterItemView[] => [
      { tier: "commitment", body: `${stamp}：继续把这件事做完` },
      { tier: "fact", body: `${stamp}：手上停在这里` },
      { tier: "judgment", body: `${stamp}：下一步先看证据` },
    ];
    return {
      title: this.faults.letterNoTitle ? "" : `交接 ${stamp}`,
      author: `${residentId}#${this.faults.letterAuthorWrongGen ? outgoing + 1 : outgoing}`,
      writtenAt: new Date(2026, 8, 24, 12, this.#letterSeq).toISOString(),
      state: items(),
      intent: items(),
    };
  }

  /** 忠实副本：只做深拷贝，不改内容。 */
  #copyLetter(letter: LetterView): LetterView {
    return {
      ...letter,
      state: letter.state.map((item) => ({ ...item })),
      intent: letter.intent.map((item) => ({ ...item })),
    };
  }

  /**
   * 启动包注入的那封。改坏开关**只**作用在这一处——「原件 vs 转抄」才比得出差异。
   * 时间线与换气回执都走忠实副本，否则两边一起转抄，差异就消失了。
   */
  #bootpackLetter(letter: LetterView): LetterView {
    if (!this.faults.bootpackLetterTranscribed) return this.#copyLetter(letter);
    return {
      ...letter,
      title: `${letter.title}（转抄）`,
      state: letter.state.map((item) => ({ ...item, body: `${item.body}（转抄）` })),
      intent: letter.intent.map((item) => ({ ...item, body: `${item.body}（转抄）` })),
    };
  }

  #breatheInPlace(resident: SynthResident, residentId: string): BreatheOutcome {
    const from = resident.generation;
    const letter = this.#sealFor(resident, residentId);
    resident.letters.push(letter);
    resident.generation = from + 1;
    resident.tokensSinceBreath = 0;
    // 主人改的线从这一代开始生效。
    if (resident.pendingThreshold !== null) {
      resident.threshold = resident.pendingThreshold;
      resident.pendingThreshold = null;
    }
    if (this.faults.breatheChangesWindow) resident.windowId = `${resident.windowId}-x`;
    if (this.faults.breatheRewritesStream) {
      const first = resident.events[0];
      if (first !== undefined) resident.events[0] = { ...first, text: `${first.text}~改史` };
    }
    return {
      fromGeneration: from,
      toGeneration: resident.generation,
      windowId: this.faults.breatheChangesWindow ? resident.windowId : resident.windowId,
      letter: this.#copyLetter(letter),
    };
  }

  #adapterFor(channel: ChannelSpec): "pi-claude-bridge" | "pi-ai" {
    return channel.claudeSubscription ? "pi-claude-bridge" : "pi-ai";
  }

  #otherAdapterFor(channel: ChannelSpec): "pi-claude-bridge" | "pi-ai" {
    return channel.claudeSubscription ? "pi-ai" : "pi-claude-bridge";
  }
}

// —— 测试侧工具 ——

interface LampOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** 模拟 runner 的循环：每盏灯前 `reset()`，灯之间不共享住户状态。 */
async function runAllLamps(raw: ResidentRuntimeDriver): Promise<LampOutcome[]> {
  const driver = cloneResidentRuntimeDriverBoundary(raw);
  const outcomes: LampOutcome[] = [];
  for (const check of residentRuntimeChecks) {
    await driver.reset();
    // 判卷断言失败是**抛**出来的，真 runner 用 try/catch 收敛成红灯。这里照做——
    // 不接住的话，一盏灯抛错会把整轮跑挂掉，改坏对照就无从谈起。
    try {
      const result: ResidentRuntimeCheckResult = await check.run(driver);
      outcomes.push({ id: check.id, passed: result.passed, detail: result.detail });
    } catch (error) {
      outcomes.push({
        id: check.id,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

function lampById(outcomes: readonly LampOutcome[], id: string): LampOutcome {
  const found = outcomes.find((outcome) => outcome.id === id);
  if (found === undefined) throw new Error(`没有 ${id} 这盏灯`);
  return found;
}

let driver: SyntheticDriver;

beforeEach(() => {
  driver = new SyntheticDriver();
});

afterEach(() => {
  driver.dispose();
});

describe("判卷正对照：合规实现七盏全绿", () => {
  it("连跑七盏全绿（模拟 runner：每盏灯前 reset）", async () => {
    const outcomes = await runAllLamps(driver);
    const red = outcomes.filter((outcome) => !outcome.passed);
    expect(red.map((outcome) => `${outcome.id}：${outcome.detail}`)).toEqual([]);
    expect(outcomes).toHaveLength(7);
  });

  it("每盏灯单独跑也全绿", async () => {
    for (const check of residentRuntimeChecks) {
      await driver.reset();
      const result = await check.run(cloneResidentRuntimeDriverBoundary(driver));
      expect(result.passed, `${check.id}：${result.detail}`).toBe(true);
    }
  });
});

describe("判卷反对照：改坏必须变红", () => {
  // —— #200 审读点名的三条阻塞，各钉一个方向 ——

  it("reset() 不清状态 → RT-02 红（#200 审读第 1 条）", async () => {
    driver.faults.resetDoesNothing = true;
    const outcomes = await runAllLamps(driver);
    expect(lampById(outcomes, "RT-02").passed).toBe(false);
  });

  it("检索根里多一份 buildBootPack 定义 → RT-07 红（#200 审读第 2 条假绿）", async () => {
    driver.faults.secondBootPackDefinition = true;
    const outcomes = await runAllLamps(driver);
    const lamp = lampById(outcomes, "RT-07");
    expect(lamp.passed).toBe(false);
    expect(lamp.detail).toContain("buildBootPack");
  });

  it("各代交接信内容完全相同（写死模板）→ RT-03 仍绿（#200 审读第 3 条的回归钉）", async () => {
    driver.faults.lettersShareTemplate = true;
    const outcomes = await runAllLamps(driver);
    const lamp = lampById(outcomes, "RT-03");
    expect(lamp.passed, lamp.detail).toBe(true);
  });

  it("各代交接信内容各不相同 → RT-03 仍绿（D8「当刻亲笔」）", async () => {
    const outcomes = await runAllLamps(driver);
    expect(lampById(outcomes, "RT-03").passed).toBe(true);
  });

  // —— RT-01 ——

  it("两种失败码塌成同一个 → RT-01 红", async () => {
    driver.faults.collapseCredentialCodes = true;
    expect(lampById(await runAllLamps(driver), "RT-01").passed).toBe(false);
  });

  it("失败时 remedy 为空 → RT-01 红（静默失败）", async () => {
    driver.faults.emptyRemedy = true;
    expect(lampById(await runAllLamps(driver), "RT-01").passed).toBe(false);
  });

  it("失败的 say 也落账 → RT-01 红（失败伪造回复）", async () => {
    driver.faults.failedSayStillRecords = true;
    expect(lampById(await runAllLamps(driver), "RT-01").passed).toBe(false);
  });

  // —— RT-02 ——

  it("落盘长出第二个一窗流文件 → RT-02 红（长了第二条会话）", async () => {
    driver.faults.secondStreamFile = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  it("重启复用 pid / bootId → RT-02 红（单进程假装重启）", async () => {
    driver.faults.restartReusesIdentity = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  it("重启换了落盘目录 → RT-02 红", async () => {
    driver.faults.restartChangesDataDir = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  it("重启时改写旧事件 → RT-02 红（杀进程不许动流）", async () => {
    driver.faults.restartMutatesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-02").passed).toBe(false);
  });

  // —— RT-03 ——

  it("窗开工后还能给自己改线 → RT-03 红（D8 给自己续命）", async () => {
    driver.faults.windowCanRetune = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("主人改线当刻生效 → RT-03 红（应当从下一代生效）", async () => {
    driver.faults.ownerRetuneAppliesImmediately = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("say 不看触发线、永不换代 → RT-03 红", async () => {
    driver.faults.thresholdNotEnforced = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("/compact 不换代 → RT-03 红（这就是自动 compact）", async () => {
    driver.faults.compactDoesNotRotate = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("换气把 windowId 换了 → RT-03 红", async () => {
    driver.faults.breatheChangesWindow = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("换气改写旧流水 → RT-03 红（改史不是长新枝）", async () => {
    driver.faults.breatheRewritesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("交接信签名用错代际 → RT-03 红（冒署）", async () => {
    driver.faults.letterAuthorWrongGen = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("交接信缺标题 → RT-03 红（D8 补记四）", async () => {
    driver.faults.letterNoTitle = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("启动包注入的是转抄不是原件 → RT-03 红", async () => {
    driver.faults.bootpackLetterTranscribed = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  it("猝死那代的原始流水进了继任者上下文 → RT-03 红（D8 三）", async () => {
    driver.faults.suddenDeathCarriesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-03").passed).toBe(false);
  });

  // —— RT-04 ——

  it("通道路由接反 → RT-04 红（D25 三）", async () => {
    driver.faults.routeSwapped = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  it("换通道换了 residentId → RT-04 红（D25 五）", async () => {
    driver.faults.switchChannelChangesResident = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  it("换通道改了记忆集合 → RT-04 红（D25 五）", async () => {
    driver.faults.switchChannelMutatesMemory = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  it("换通道改写了一窗流旧条目 → RT-04 红", async () => {
    driver.faults.switchChannelRewritesStream = true;
    expect(lampById(await runAllLamps(driver), "RT-04").passed).toBe(false);
  });

  // —— RT-05 ——

  it("流式只有 1 个增量 → RT-05 红（不是流式吐出）", async () => {
    driver.faults.singleStreamChunk = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  it("画面长出会话列表 → RT-05 红（D9 / D11 四）", async () => {
    driver.faults.sessionListShown = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  it("状态栏缺模型 → RT-05 红", async () => {
    driver.faults.statusMissingModel = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  it("出错却静默 → RT-05 红", async () => {
    driver.faults.silentFailure = true;
    expect(lampById(await runAllLamps(driver), "RT-05").passed).toBe(false);
  });

  // —— RT-06 ——

  it("credentialRef 就是密钥明文 → RT-06 红", async () => {
    driver.faults.credentialRefIsPlaintext = true;
    expect(lampById(await runAllLamps(driver), "RT-06").passed).toBe(false);
  });

  it("扫描器恒返回空命中 → RT-06 红（正对照失效）", async () => {
    driver.faults.scannerAlwaysEmpty = true;
    expect(lampById(await runAllLamps(driver), "RT-06").passed).toBe(false);
  });

  it("密钥明文漏进一窗流 → RT-06 红", async () => {
    driver.faults.secretLeaksIntoStream = true;
    expect(lampById(await runAllLamps(driver), "RT-06").passed).toBe(false);
  });
});
