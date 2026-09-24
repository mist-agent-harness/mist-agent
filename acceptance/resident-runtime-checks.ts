/**
 * #194 RT-01～RT-07 的七盏可执行判卷。
 *
 * 清单真源：`acceptance/resident-runtime.md`。两边必须同步改，判卷以代码为准。
 *
 * 判卷纪律（照 `acceptance/README.md`）：只做确定性断言——比字节、比序号、比内容
 * hash、比结构化错误与真实副作用；**不判回复的措辞**。每盏灯都带正对照：先证明
 * 被判的行为确实有机会发生，再证明它没被偷懒实现糊过去，否则断言空转也能点绿。
 *
 * 灯与灯之间不共享住户状态：每盏灯用自己的 `residentId` / `windowId`，runner 另在
 * 每盏灯前调 `reset()`。两道都上，是因为「前一盏留下的状态把后一盏判红」这种假红
 * 曾经真的发生过（#200 审读第 1 条）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BootPackView,
  ChannelSpec,
  JsonValue,
  LetterView,
  ResidentRuntimeCheck,
  ResidentRuntimeCheckResult,
  ResidentRuntimeDriver,
  StreamEventView,
  StreamSnapshot,
} from "./resident-runtime-driver.ts";
import {
  WRITE_PATH_MARKERS,
  WRITE_PATH_SURFACES,
  auditResidentRuntimeWriteSurface,
} from "./resident-runtime-write-surface.ts";

const pass = (detail: string): ResidentRuntimeCheckResult => ({ passed: true, detail });
const fail = (detail: string): ResidentRuntimeCheckResult => ({ passed: false, detail });

/** 判卷内部的断言失败：由每盏灯自己收敛成红灯理由，不冒充驱动抛错。 */
class CheckFailure extends Error {}

function fatal(detail: string): never {
  throw new CheckFailure(detail);
}

function expect(condition: boolean, detail: string): void {
  if (!condition) fatal(detail);
}

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

// —— 夹具常量。判卷自带蜜罐密钥，不碰任何真实凭证。 ——

const CANARY_SECRET = "sk-canary-4f19b0e7c26a8d53";

/**
 * 每盏灯一套自己的住户 / 窗标识。灯之间不共享住户——上一盏的残留不许把下一盏判红。
 * runner 另在每盏灯前调 `reset()`；两道一起上，单独失效一道也还有另一道。
 */
const residentFor = (id: string): string =>
  `resident-${id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
const windowFor = (id: string): string => `window-${id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

const CHANNEL_A: ChannelSpec = {
  claudeSubscription: false,
  credentialKind: "api-key",
  model: "model-alpha",
};

const CHANNEL_B: ChannelSpec = {
  claudeSubscription: false,
  credentialKind: "api-key",
  model: "model-beta",
};

const LEGAL_TIERS = new Set(["commitment", "fact", "judgment"]);

/** 每盏灯换一个唯一标记，避免上一盏的残留把这一盏点绿。 */
function markerFor(checkId: string, slot: string): string {
  return `${checkId}-${slot}-${sha256(`${checkId}/${slot}`).slice(0, 12)}`;
}

// —— 可比指纹 ——

function eventFingerprint(event: StreamEventView): string {
  return stableJson({
    eventId: event.eventId,
    streamSeq: event.streamSeq,
    kind: event.kind,
    text: event.text,
    payloadHash: event.payloadHash,
  });
}

function snapshotFingerprint(snapshot: StreamSnapshot): string[] {
  return snapshot.events.map(eventFingerprint);
}

/**
 * 同一封信的两个视图之间的形状指纹（不含 `writtenAt`）。
 *
 * 只用于比「启动包注入的那封」和「当刻亲笔那封」是不是**同一封**——这是副本等价性，
 * 比的是字节。**不许拿它比不同代的信**：交接信是住户不同时刻亲笔写的，D8「当刻亲笔」
 * 就意味着内容每代不同，拿它跨代比等于逼实现写死模板（#200 审读第 3 条）。
 */
function letterShape(letter: LetterView): string {
  return stableJson({
    title: letter.title,
    state: letter.state.map((item) => ({ tier: item.tier, body: item.body })),
    intent: letter.intent.map((item) => ({ tier: item.tier, body: item.body })),
  });
}

function memorySetFingerprint(pack: BootPackView): string {
  return stableJson(
    pack.memories
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        supersededBy: memory.supersededBy,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
  );
}

function assertLetterWellFormed(letter: LetterView, where: string): void {
  expect(letter.title.trim().length > 0, `${where}：交接信标题为空——D8 补记四，标题即召回锚点`);
  expect(letter.writtenAt.trim().length > 0, `${where}：交接信没有 writtenAt——不是当刻亲笔`);
  for (const item of [...letter.state, ...letter.intent]) {
    expect(
      LEGAL_TIERS.has(item.tier),
      `${where}：交接信条目 tier 是 ${item.tier}——D8 补记三只有 commitment / fact / judgment 三档`,
    );
  }
}

/**
 * 失败的 say 不许伪造回复。读流报「不存在」是合法的（确实没落账）；
 * 读到了就必须一条带标记的都没有。
 */
async function assertNothingRecorded(
  driver: ResidentRuntimeDriver,
  residentId: string,
  marker: string,
): Promise<void> {
  const snapshot = await driver.readStream({ residentId });
  if (!snapshot.ok) {
    expect(
      snapshot.error.code === "stream-not-found",
      `失败后读流报 ${snapshot.error.code}——只有 stream-not-found 才是「确实没落账」`,
    );
    return;
  }
  const leaked = snapshot.value.events.filter((event) => event.text.includes(marker));
  expect(
    leaked.length === 0,
    `失败的 say 却落了 ${leaked.length} 条带标记的事件——失败不许伪造回复`,
  );
}

function writeFixtureTree(root: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
}

/**
 * 三个唯一实现各被恰好定义一次。
 *
 * 故意混进一个**方法门面** `Harness.buildBootPack`、几处普通调用和一个别名调用：
 * 按定义判，它们都不算第二份实现（#200 审读第 2 条指出的假红 / 假绿就在这儿）。
 */
const CLEAN_FIXTURE = `export class CanonicalStreamWriter {
  submit() {}
}
export function sealLetter(draft) {
  return draft;
}
export function buildBootPack(store, residentId) {
  return residentId;
}
export function assemble() {
  const writer = new CanonicalStreamWriter();
  const letter = sealLetter({});
  const pack = buildBootPack({}, "r");
  return { writer, letter, pack };
}
`;

/** 一处实现都没有（只有门面与调用）——三个面都该报 write-path-missing。 */
const EMPTY_FIXTURE = `export class Harness {
  async buildBootPack(residentId) {
    return assembleBootPack({}, residentId);
  }
  sealLetter(draft) {
    return draft;
  }
}
export function assemble() {
  new CanonicalStreamWriter();
  return null;
}
`;

/** 每个实现各定义一次，用来和另一个根里的那一份凑成「第二份写入路径」。 */
const HALF_FIXTURE = `export class CanonicalStreamWriter {
  submit() {}
}
export function sealLetter(draft) {
  return draft;
}
export function buildBootPack(store, residentId) {
  return residentId;
}
`;

export const residentRuntimeChecks: readonly ResidentRuntimeCheck[] = [
  {
    id: "RT-01",
    title: "醒来：读启动包、真实对话往返、凭证缺失与失效都 fail-closed 且可操作",
    uses: ["provisionChannel", "say", "revokeCredential", "bootPack", "readStream"],
    async run(driver) {
      const RESIDENT = residentFor("RT-01");
      const marker = markerFor("RT-01", "boot");

      // —— 失败分支一：从未配过凭证 ——
      const missing = await driver.say({ residentId: RESIDENT, text: marker });
      expect(!missing.ok, "没配凭证却说成了话——必须 fail-closed");
      if (missing.ok) fatal("没配凭证却说成了话");
      expect(
        missing.error.code === "credential-missing",
        `没配凭证的失败码应为 credential-missing，实得 ${missing.error.code}`,
      );
      expect(
        missing.error.remedy.trim().length > 0,
        "credential-missing 的 remedy 是空的——要求「给出可操作提示，不静默」",
      );
      expect(missing.error.message.trim().length > 0, "credential-missing 连 message 都是空的");
      await assertNothingRecorded(driver, RESIDENT, marker);

      // —— 正对照：配好凭证后这条路确实通 ——
      const provisioned = await driver.provisionChannel({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        canarySecret: CANARY_SECRET,
      });
      if (!provisioned.ok) {
        fatal(`配通道失败：${provisioned.error.code} ${provisioned.error.message}`);
      }
      const bootMarker = markerFor("RT-01", "roundtrip");
      const said = await driver.say({ residentId: RESIDENT, text: bootMarker });
      if (!said.ok) fatal(`配好凭证仍不能往返：${said.error.code} ${said.error.message}`);
      expect(said.value.reply.trim().length > 0, "真实往返却拿到空回复——这条通道没真跑");
      expect(
        said.value.residentId === RESIDENT,
        `往返回来的 residentId 是 ${said.value.residentId}`,
      );

      const pack = await driver.bootPack({ residentId: RESIDENT });
      if (!pack.ok) fatal(`读启动包失败：${pack.error.code} ${pack.error.message}`);
      expect(pack.value.residentId === RESIDENT, `启动包 residentId 是 ${pack.value.residentId}`);
      expect(pack.value.identity.trim().length > 0, "启动包身份栏为空——醒来没读到人");

      // —— 失败分支二：凭证失效，与「没配」机器可分 ——
      await driver.revokeCredential({ residentId: RESIDENT });
      const revokedMarker = markerFor("RT-01", "revoked");
      const invalid = await driver.say({ residentId: RESIDENT, text: revokedMarker });
      expect(!invalid.ok, "凭证失效却说成了话");
      if (invalid.ok) fatal("凭证失效却说成了话");
      expect(
        invalid.error.code === "credential-invalid",
        `凭证失效的失败码应为 credential-invalid，实得 ${invalid.error.code}——「没配」与「失效」必须机器可分，不许塌成同一个码`,
      );
      expect(
        invalid.error.remedy.trim().length > 0,
        "credential-invalid 的 remedy 是空的——要求「给出可操作提示，不静默」",
      );
      await assertNothingRecorded(driver, RESIDENT, revokedMarker);

      return pass(
        `没配→${missing.error.code}（提示 ${missing.error.remedy.length} 字）；` +
          `配好→真实往返 ${said.value.reply.length} 字 + 启动包身份非空；` +
          `失效→${invalid.error.code}（提示 ${invalid.error.remedy.length} 字）；两次失败都没落账`,
      );
    },
  },

  {
    id: "RT-02",
    title: "写流：用户与回复都经唯一 writer 落账，跨进程重启同一条主流，不长第二条会话",
    uses: ["provisionChannel", "say", "readStream", "streamFiles", "killHost", "startHost"],
    async run(driver) {
      const RESIDENT = residentFor("RT-02");
      const provisioned = await driver.provisionChannel({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        canarySecret: CANARY_SECRET,
      });
      if (!provisioned.ok) fatal(`配通道失败：${provisioned.error.code}`);

      // —— 正对照：落账确实发生了，而且是 user + assistant 各一条 ——
      const first = markerFor("RT-02", "first");
      const said = await driver.say({ residentId: RESIDENT, text: first });
      if (!said.ok) fatal(`say 失败：${said.error.code}`);
      const before = await driver.readStream({ residentId: RESIDENT });
      if (!before.ok) fatal(`读流失败：${before.error.code}`);
      expect(
        before.value.events.length === 2,
        `说了一句只落了 ${before.value.events.length} 条，应为 user + assistant 各一条`,
      );
      expect(
        before.value.events[0]?.kind === "user" && before.value.events[1]?.kind === "assistant",
        `落账顺序是 ${before.value.events.map((event) => event.kind).join("→")}，应为 user→assistant`,
      );
      expect(
        before.value.events.some((event) => event.text.includes(first)),
        "一窗流里找不到刚说的那句话——这条通道根本没写流",
      );
      expect(before.value.residentId === RESIDENT, "流上挂的 residentId 不对");

      // —— 一位住户一条生命线：落盘文件恰好一个 ——
      const filesBefore = await driver.streamFiles();
      if (!filesBefore.ok) fatal(`读落盘清单失败：${filesBefore.error.code}`);
      expect(
        filesBefore.value.files.length === 1,
        `一窗流落盘文件有 ${filesBefore.value.files.length} 个（${filesBefore.value.files.join("、")}）——D9 一位住户一条权威生命线，多一个就是长了第二条会话`,
      );

      // —— 再说一句，仍然只有一条 ——
      const second = markerFor("RT-02", "second");
      const saidAgain = await driver.say({ residentId: RESIDENT, text: second });
      if (!saidAgain.ok) fatal(`第二次 say 失败：${saidAgain.error.code}`);
      const grown = await driver.readStream({ residentId: RESIDENT });
      if (!grown.ok) fatal(`读流失败：${grown.error.code}`);
      expect(
        grown.value.events.length === 4,
        `两句话落了 ${grown.value.events.length} 条，应为 4 条`,
      );
      const filesGrown = await driver.streamFiles();
      if (!filesGrown.ok) fatal(`读落盘清单失败：${filesGrown.error.code}`);
      expect(
        filesGrown.value.files.length === 1,
        `说了两句之后一窗流落盘文件变成 ${filesGrown.value.files.length} 个——不许长出第二条会话`,
      );

      // —— 跨进程重启：换了个进程，读回逐项等价 ——
      const beforeKill = await driver.hostDescriptor();
      const fingerprintsBefore = snapshotFingerprint(grown.value);
      await driver.killHost();
      const afterBoot = await driver.startHost();
      expect(afterBoot.pid !== beforeKill.pid, `重启后 pid 还是 ${afterBoot.pid}——没真的换进程`);
      expect(afterBoot.bootId !== beforeKill.bootId, "重启后 bootId 没变——没真的换进程");
      expect(afterBoot.dataDir === beforeKill.dataDir, "重启换了落盘目录，读回的就不是同一份底");

      const afterRestart = await driver.readStream({ residentId: RESIDENT });
      if (!afterRestart.ok) fatal(`重启后读流失败：${afterRestart.error.code}`);
      const fingerprintsAfter = snapshotFingerprint(afterRestart.value);
      expect(
        fingerprintsBefore.length === fingerprintsAfter.length,
        `重启前后条目数变了：${fingerprintsBefore.length} → ${fingerprintsAfter.length}`,
      );
      for (let index = 0; index < fingerprintsBefore.length; index += 1) {
        expect(
          fingerprintsBefore[index] === fingerprintsAfter[index],
          `重启后第 ${index} 条事件的指纹变了——杀进程不许动流`,
        );
      }
      const filesAfter = await driver.streamFiles();
      if (!filesAfter.ok) fatal(`读落盘清单失败：${filesAfter.error.code}`);
      expect(filesAfter.value.files.length === 1, "重启后又冒出第二个一窗流文件");

      return pass(
        `2 句 → 4 条事件（user→assistant 各两轮）；落盘文件恒 1 个；pid ${beforeKill.pid}→${afterBoot.pid}、bootId ${beforeKill.bootId.slice(0, 8)}→${afterBoot.bootId.slice(0, 8)}；${fingerprintsAfter.length} 条事件指纹逐项等价`,
      );
    },
  },

  {
    id: "RT-03",
    title: "换代：到线亲笔写信后换代，新一代读得到信，三个入口同流程且没有自动 compact",
    uses: [
      "provisionChannel",
      "say",
      "setBreathThreshold",
      "breathe",
      "letterTimeline",
      "bootPack",
      "readStream",
      "suddenDeath",
      "archivedTranscript",
    ],
    async run(driver) {
      const RESIDENT = residentFor("RT-03");
      const WINDOW = windowFor("RT-03");
      const provisioned = await driver.provisionChannel({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        canarySecret: CANARY_SECRET,
      });
      if (!provisioned.ok) fatal(`配通道失败：${provisioned.error.code}`);

      // 代际是 1 起点：现役栈 SessionRegistry.open 的第一代是 (last ?? 0)+1 = 1，
      // journal 拒 generation < 1，formatAuthor 是 `${id}#${generation}`。判卷按这套
      // 1 起点算，任何接真实栈的正确实现才不会被判红（#200 技术门第 1 条）。
      const OPEN_GENERATION = 1;

      // —— 子判卷 A：触发线真的被 say 执行（另起一个住户，隔离于主流程） ——
      // 线设成 1：任何一句 say（token 数 ≥ 1）都必须到线、自动换代。这判死两件事：
      //   · say 根本不看触发线、永不换代（thresholdNotEnforced 故障）；
      //   · 主人改的线当刻就生效而不是从下一代（ownerRetuneAppliesImmediately 故障）——
      //     主人把线从「够高」压到 1，若当刻生效则这句就到线换代（错），从下一代生效才对。
      const CROSSER = residentFor("RT-03-crosser");
      const CROSSER_WINDOW = windowFor("RT-03-crosser");
      const crosserChannel = await driver.provisionChannel({
        residentId: CROSSER,
        channel: CHANNEL_A,
        canarySecret: CANARY_SECRET,
      });
      if (!crosserChannel.ok) fatal(`配通道失败：${crosserChannel.error.code}`);
      // 开工线设得够高：主人随后压低，用来判「当刻不生效、下一代才生效」。
      const crosserOpen = await driver.setBreathThreshold({
        residentId: CROSSER,
        windowId: CROSSER_WINDOW,
        generation: OPEN_GENERATION,
        thresholdTokens: Number.MAX_SAFE_INTEGER,
        authority: "window",
      });
      if (!crosserOpen.ok) fatal(`crosser 开工设线被拒：${crosserOpen.error.code}`);
      const ownerLower = await driver.setBreathThreshold({
        residentId: CROSSER,
        windowId: CROSSER_WINDOW,
        generation: OPEN_GENERATION,
        thresholdTokens: 1,
        authority: "owner",
      });
      if (!ownerLower.ok) fatal(`crosser 主人压低线被拒：${ownerLower.error.code}`);
      // 主人压低的线从下一代才生效：这一句仍按开工的高线走，不到线、不换代。
      // 用「时间线里还没有信」判——若主人的低线当刻就生效，这句会到线换代、落下一封信。
      const crosserFirst = await driver.say({
        residentId: CROSSER,
        text: markerFor("RT-03", "c1"),
      });
      if (!crosserFirst.ok) fatal(`crosser say 失败：${crosserFirst.error.code}`);
      const afterFirst = await driver.letterTimeline({ residentId: CROSSER });
      if (!afterFirst.ok) fatal(`读 crosser 时间线失败：${afterFirst.error.code}`);
      expect(
        afterFirst.value.letters.length === 0,
        `主人压低的线当刻就生效了（这句已落下 ${afterFirst.value.letters.length} 封信换了代）——应从下一代才生效`,
      );
      // 用显式 breathe 进到下一代，让主人那条低线（=1）生效。
      const crosserBreathe = await driver.breathe({ residentId: CROSSER, via: "new" });
      if (!crosserBreathe.ok) fatal(`crosser 换气失败：${crosserBreathe.error.code}`);
      // 现在低线（1）已生效：下一句 say 必须到线、自动再换一代。判死 thresholdNotEnforced。
      const crosserSecond = await driver.say({
        residentId: CROSSER,
        text: markerFor("RT-03", "c2"),
      });
      if (!crosserSecond.ok) fatal(`crosser say 失败：${crosserSecond.error.code}`);
      const crosserTimeline = await driver.letterTimeline({ residentId: CROSSER });
      if (!crosserTimeline.ok) fatal(`读 crosser 时间线失败：${crosserTimeline.error.code}`);
      expect(
        crosserTimeline.value.letters.length >= 2,
        `低线生效后 say 没有到线换代（时间线只有 ${crosserTimeline.value.letters.length} 封信）——say 不看触发线`,
      );

      // 开工阈值设成够高，单句 say 到不了线：这样第一句只起回合、不自动换代，正好用来判
      // 「回合已起后窗无权改自己的线」。代际的确定性推进用 D8 的显式入口 breathe()，
      // 不靠猜驱动的每句 token 数（那是驱动内部实现，判卷不该耦合）。
      const OPEN_THRESHOLD = Number.MAX_SAFE_INTEGER;

      // —— 正对照：触发线是开工时（第一代、尚未起回合）窗自己真的设得进去的 ——
      const opened = await driver.setBreathThreshold({
        residentId: RESIDENT,
        windowId: WINDOW,
        generation: OPEN_GENERATION,
        thresholdTokens: OPEN_THRESHOLD,
        authority: "window",
      });
      if (!opened.ok) fatal(`开工设阈值被拒：${opened.error.code} ${opened.error.message}`);

      // —— 第一句：起了回合但没到线（不换代） ——
      const firstSay = await driver.say({
        residentId: RESIDENT,
        text: markerFor("RT-03", "warmup"),
      });
      if (!firstSay.ok) fatal(`say 失败：${firstSay.error.code}`);
      expect(
        firstSay.value.generation === OPEN_GENERATION,
        `第一句的代际是 ${firstSay.value.generation}，应为 ${OPEN_GENERATION}——线设得够高，这句不该到线换代`,
      );

      // —— 窗改不了自己的线：D8 禁的是「运行中的窗给自己续命」。现役 turn-gate 的锁在
      // 回合起了之后才合上（#markTurnStarted 在 beforeTurn；MV-D02 宿主测试是开工
      // configure 成功、先 say、再改才 CONFIG_INVALID）。所以这条拒绝断言放在第一句
      // **之后**——放在起回合之前会把「开工阶段窗还能配线」的正确实现判红（#200 技术门
      // 第 2 条）。——
      const rethreshold = await driver.setBreathThreshold({
        residentId: RESIDENT,
        windowId: WINDOW,
        generation: firstSay.value.generation,
        thresholdTokens: 1_000,
        authority: "window",
      });
      expect(!rethreshold.ok, "回合已起，窗还能给自己改触发线——D8 禁止运行中的窗给自己续命");
      if (rethreshold.ok) fatal("回合已起，窗还能给自己改触发线");
      expect(
        rethreshold.error.code === "breath-refused",
        `运行中的窗改阈值应报 breath-refused，实得 ${rethreshold.error.code}`,
      );

      // —— 主人能改成员配置；D8 禁的是窗给自己续命，不是主人不能改（从下一代生效）。 ——
      const ownerRetune = await driver.setBreathThreshold({
        residentId: RESIDENT,
        windowId: WINDOW,
        generation: firstSay.value.generation,
        thresholdTokens: 1_000_000_000,
        authority: "owner",
      });
      if (!ownerRetune.ok) {
        fatal(
          `主人改成员配置被拒：${ownerRetune.error.code} ${ownerRetune.error.message}——D8 禁的是窗给自己续命，不是主人不能改配置`,
        );
      }

      // —— 换代走 D8 的显式入口：第一代亲笔写信 → 换到第二代。回执报换代前那代（补记一）。 ——
      const crossed = await driver.breathe({ residentId: RESIDENT, via: "new" });
      if (!crossed.ok) fatal(`换气失败：${crossed.error.code} ${crossed.error.message}`);
      expect(
        crossed.value.fromGeneration === OPEN_GENERATION &&
          crossed.value.toGeneration === OPEN_GENERATION + 1,
        `换代增量是 ${crossed.value.fromGeneration}→${crossed.value.toGeneration}，应为 ${OPEN_GENERATION}→${OPEN_GENERATION + 1}`,
      );

      const timeline = await driver.letterTimeline({ residentId: RESIDENT });
      if (!timeline.ok) fatal(`读交接信时间线失败：${timeline.error.code}`);
      expect(
        timeline.value.letters.length === 1,
        `换了一代却有 ${timeline.value.letters.length} 封信——每代恰好一封`,
      );
      const firstLetter = timeline.value.letters[0];
      if (firstLetter === undefined) fatal("时间线里没有信");
      assertLetterWellFormed(firstLetter, "第一封");
      expect(
        firstLetter.author === `${RESIDENT}#${OPEN_GENERATION}`,
        `第一封信签名是 ${firstLetter.author}——应为 ${RESIDENT}#${OPEN_GENERATION}（写下这封信的是换代前那代）`,
      );

      // —— 新一代读得到交接信：醒来即已读，注入的是原件不是转抄 ——
      const pack = await driver.bootPack({ residentId: RESIDENT });
      if (!pack.ok) fatal(`读启动包失败：${pack.error.code}`);
      expect(pack.value.letter !== null, "新一代启动包里没有交接信——D8 补记三要求随包注入");
      const injected = pack.value.letter;
      if (injected === null) fatal("新一代启动包里没有交接信");
      expect(
        injected.title === firstLetter.title,
        `启动包里的信标题是 ${injected.title}，应为 ${firstLetter.title}`,
      );
      expect(
        letterShape(injected) === letterShape(firstLetter),
        "启动包注入的交接信与当刻亲笔那封不同形——注入的不是原件（这是副本等价性，不是要求各代内容相同）",
      );

      // —— 主人改的线从下一代才生效：新一代按新线走，不再自动换气 ——
      const nextGen = await driver.say({
        residentId: RESIDENT,
        text: markerFor("RT-03", "nextgen"),
      });
      if (!nextGen.ok) fatal(`say 失败：${nextGen.error.code}`);
      // 触发那句 say 到线换了一代（OPEN_GENERATION → +1），所以新一代是 OPEN_GENERATION+1；
      // 且主人的线（1_000_000）已在这一代生效，这句不再自动换气，代际停在 +1。
      const nextGeneration = OPEN_GENERATION + 1;
      expect(
        nextGen.value.generation === nextGeneration,
        `新一代代际是 ${nextGen.value.generation}，应为 ${nextGeneration}——主人改的线没在新一代生效（否则又被自动换气顶走）`,
      );

      // —— 三个入口同流程。判结构不变量，不判信的内容（D8「当刻亲笔」） ——
      const streamBeforeTriggers = await driver.readStream({ residentId: RESIDENT });
      if (!streamBeforeTriggers.ok) fatal(`读流失败：${streamBeforeTriggers.error.code}`);
      const streamBefore = snapshotFingerprint(streamBeforeTriggers.value);

      let expectedFrom = nextGeneration;
      for (const via of ["new", "clear", "compact"] as const) {
        const breathed = await driver.breathe({ residentId: RESIDENT, via });
        if (!breathed.ok)
          fatal(`/${via} 换气失败：${breathed.error.code} ${breathed.error.message}`);
        expect(
          breathed.value.fromGeneration === expectedFrom &&
            breathed.value.toGeneration === expectedFrom + 1,
          `/${via} 的代际增量是 ${breathed.value.fromGeneration}→${breathed.value.toGeneration}，` +
            `应为 ${expectedFrom}→${expectedFrom + 1}——不是换代就不是 D8 的流程`,
        );
        expect(
          breathed.value.windowId === WINDOW,
          `/${via} 换气把 windowId 换成了 ${breathed.value.windowId}`,
        );
        assertLetterWellFormed(breathed.value.letter, `/${via}`);
        expect(
          breathed.value.letter.author === `${RESIDENT}#${expectedFrom}`,
          `/${via} 的信签名是 ${breathed.value.letter.author}，应为 ${RESIDENT}#${expectedFrom}`,
        );
        expectedFrom += 1;
      }

      // 自动 compact 的形状是「压了正文但没换代」；判它不存在的机器形式是：
      // 换代一律 +1（上面已判），且旧流水逐字留底、没有被压缩改写。
      const streamAfterTriggers = await driver.readStream({ residentId: RESIDENT });
      if (!streamAfterTriggers.ok) fatal(`读流失败：${streamAfterTriggers.error.code}`);
      const streamAfter = snapshotFingerprint(streamAfterTriggers.value);
      expect(
        streamAfter.length >= streamBefore.length,
        `换气把流里的条目从 ${streamBefore.length} 条压成了 ${streamAfter.length} 条——这就是自动 compact`,
      );
      for (let index = 0; index < streamBefore.length; index += 1) {
        expect(
          streamBefore[index] === streamAfter[index],
          `换气改写了第 ${index} 条旧事件——改史的唯一合法形式是长新枝，不是压缩`,
        );
      }

      // 每代一封信：从触发那代（OPEN_GENERATION）到最后一次换气，一共换了
      // (expectedFrom - OPEN_GENERATION) 次，就该有这么多封信。用换代次数算，不用
      // 代际号——1 起点下代际号比信数大 1，写死代际号会假红。
      const expectedLetters = expectedFrom - OPEN_GENERATION;
      const finalTimeline = await driver.letterTimeline({ residentId: RESIDENT });
      if (!finalTimeline.ok) fatal(`读交接信时间线失败：${finalTimeline.error.code}`);
      expect(
        finalTimeline.value.letters.length === expectedLetters,
        `换了 ${expectedLetters} 代，时间线却有 ${finalTimeline.value.letters.length} 封信——每代一封，不多不少`,
      );

      // —— 猝死：原始流水不自动进继任者上下文，但归档里查得到（D8 三双面） ——
      const suddenMarker = markerFor("RT-03", "sudden");
      const suddenSaid = await driver.say({ residentId: RESIDENT, text: suddenMarker });
      if (!suddenSaid.ok) fatal(`say 失败：${suddenSaid.error.code}`);
      const deadGeneration = suddenSaid.value.generation;

      // 正对照：猝死前这条标记确实落进了当代流水——否则「猝死后不在继任者上下文」是空断言
      // （一个空的 suddenDeath 也能让它「不在」）。
      const streamBeforeDeath = await driver.readStream({ residentId: RESIDENT });
      if (!streamBeforeDeath.ok) fatal(`读流失败：${streamBeforeDeath.error.code}`);
      expect(
        streamBeforeDeath.value.events.some((event) => event.text.includes(suddenMarker)),
        "猝死前这条标记根本没落进流水——后面的「不进继任者」成了空断言",
      );

      await driver.suddenDeath({ residentId: RESIDENT });

      // 真的死了、真换了继任者：新一代代际必须比猝死那代更高（不是空操作）。
      const successorSaid = await driver.say({
        residentId: RESIDENT,
        text: markerFor("RT-03", "successor"),
      });
      if (!successorSaid.ok) fatal(`继任者 say 失败：${successorSaid.error.code}`);
      expect(
        successorSaid.value.generation > deadGeneration,
        `猝死后继任者代际是 ${successorSaid.value.generation}，未超过猝死那代 ${deadGeneration}——suddenDeath 是空操作，根本没换代`,
      );

      const afterDeath = await driver.bootPack({ residentId: RESIDENT });
      if (!afterDeath.ok) fatal(`猝死后读启动包失败：${afterDeath.error.code}`);
      const carried = afterDeath.value.memories.filter((memory) =>
        memory.content.includes(suddenMarker),
      );
      expect(
        carried.length === 0,
        `猝死那代的原始流水有 ${carried.length} 条自己进了继任者上下文——D8 三：不自动进，接续靠交接信加归档查询`,
      );
      expect(
        JSON.stringify(afterDeath.value.commitments).includes(suddenMarker) === false,
        "猝死那代的内容混进了承诺栏——继任者不该继承没写进信的东西",
      );

      // D8 三的正面：原始流水没有无声消失，归档里按 (residentId, generation) 查得到。
      // 只断言「不在继任者上下文」而不验归档可查，等于允许把猝死那代直接抹掉——那是丢史，
      // 不是 D8 要的「不自动进、但可查」。
      const archived = await driver.archivedTranscript({
        residentId: RESIDENT,
        generation: deadGeneration,
      });
      if (!archived.ok) {
        fatal(
          `猝死那代（第 ${deadGeneration} 代）的原始流水在归档里查不到：${archived.error.code}——D8 三要求原始流水进归档可查，不是无声消失`,
        );
      }
      expect(
        archived.value.events.some((event) => event.text.includes(suddenMarker)),
        `归档里第 ${deadGeneration} 代的流水没有那条标记——原始流水被丢了，不是「不自动进但可查」`,
      );

      return pass(
        `开工（第 ${OPEN_GENERATION} 代）设线成功、回合已起后窗改自己的线被拒、主人改线成功且当刻代际照旧换气、新一代才用上新线；跨线换代签名 ${firstLetter.author}；启动包注入的信是原件；new/clear/compact 三入口各换一代、各一封格式合法的信；旧流水 ${streamBefore.length} 条逐字留底；猝死那代内容不进继任者上下文但归档第 ${deadGeneration} 代可查`,
      );
    },
  },

  {
    id: "RT-04",
    title: "通道：Claude 订阅走 pi-claude-bridge、其余走 pi-ai，换通道不换住户",
    uses: ["resolveChannelRoute", "provisionChannel", "say", "bootPack", "readStream"],
    async run(driver) {
      const RESIDENT = residentFor("RT-04");

      // —— D25 三：Claude 订阅是唯一特例 ——
      const subscriptionRoute = await driver.resolveChannelRoute({
        channel: { claudeSubscription: true, credentialKind: "subscription", model: "model-sub" },
      });
      if (!subscriptionRoute.ok) fatal(`算路由失败：${subscriptionRoute.error.code}`);
      expect(
        subscriptionRoute.value.adapterId === "pi-claude-bridge",
        `Claude 订阅被路由到 ${subscriptionRoute.value.adapterId}——D25 三：Claude 订阅走 pi-claude-bridge`,
      );

      const apiKeyRoute = await driver.resolveChannelRoute({ channel: CHANNEL_A });
      if (!apiKeyRoute.ok) fatal(`算路由失败：${apiKeyRoute.error.code}`);
      expect(
        apiKeyRoute.value.adapterId === "pi-ai",
        `API key 通道被路由到 ${apiKeyRoute.value.adapterId}——D25 三：其余经 pi-ai`,
      );

      // —— 正对照：A 通道确实跑得通 ——
      const provisionedA = await driver.provisionChannel({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        canarySecret: CANARY_SECRET,
      });
      if (!provisionedA.ok) fatal(`配 A 通道失败：${provisionedA.error.code}`);
      const markerA = markerFor("RT-04", "a");
      const saidA = await driver.say({ residentId: RESIDENT, text: markerA });
      if (!saidA.ok) fatal(`A 通道往返失败：${saidA.error.code}`);
      const packA = await driver.bootPack({ residentId: RESIDENT });
      if (!packA.ok) fatal(`读启动包失败：${packA.error.code}`);
      const streamA = await driver.readStream({ residentId: RESIDENT });
      if (!streamA.ok) fatal(`读流失败：${streamA.error.code}`);

      // —— 换通道换模型：住户不变 ——
      const provisionedB = await driver.provisionChannel({
        residentId: RESIDENT,
        channel: CHANNEL_B,
        canarySecret: CANARY_SECRET,
      });
      if (!provisionedB.ok) fatal(`配 B 通道失败：${provisionedB.error.code}`);
      const markerB = markerFor("RT-04", "b");
      const saidB = await driver.say({ residentId: RESIDENT, text: markerB });
      if (!saidB.ok) fatal(`B 通道往返失败：${saidB.error.code}`);
      expect(
        saidB.value.residentId === RESIDENT,
        `换通道后 residentId 变成了 ${saidB.value.residentId}`,
      );
      expect(saidB.value.model === CHANNEL_B.model, `换模型后 model 是 ${saidB.value.model}`);

      const packB = await driver.bootPack({ residentId: RESIDENT });
      if (!packB.ok) fatal(`读启动包失败：${packB.error.code}`);
      expect(
        packB.value.residentId === packA.value.residentId,
        "换通道把启动包上的 residentId 换了",
      );
      expect(
        memorySetFingerprint(packB.value) === memorySetFingerprint(packA.value),
        "换通道把记忆集合改了——D25 五：身份、记忆和绑定都不变",
      );

      const streamB = await driver.readStream({ residentId: RESIDENT });
      if (!streamB.ok) fatal(`读流失败：${streamB.error.code}`);
      const beforeB = snapshotFingerprint(streamA.value);
      const afterB = snapshotFingerprint(streamB.value);
      expect(
        afterB.length >= beforeB.length,
        `换通道把流从 ${beforeB.length} 条压成 ${afterB.length} 条——一窗流只许追加`,
      );
      for (let index = 0; index < beforeB.length; index += 1) {
        expect(beforeB[index] === afterB[index], `换通道改写了第 ${index} 条旧事件`);
      }

      return pass(
        `订阅→${subscriptionRoute.value.adapterId}、api-key→${apiKeyRoute.value.adapterId}；` +
          `换 ${CHANNEL_A.model}→${CHANNEL_B.model} 后 residentId 不变、记忆集合同指纹、` +
          `一窗流旧 ${beforeB.length} 条逐字不变只追加`,
      );
    },
  },

  {
    id: "RT-05",
    title: "TUI：一条会话没有会话列表，流式回复、错误、当前住户与模型都看得见",
    uses: ["provisionChannel", "tuiTranscript"],
    async run(driver) {
      const RESIDENT = residentFor("RT-05");
      const provisioned = await driver.provisionChannel({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        canarySecret: CANARY_SECRET,
      });
      if (!provisioned.ok) fatal(`配通道失败：${provisioned.error.code}`);

      const marker = markerFor("RT-05", "chat");
      const normal = await driver.tuiTranscript({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        script: [{ kind: "input", text: marker }],
      });
      if (!normal.ok) fatal(`TUI 脚本跑不完：${normal.error.code} ${normal.error.message}`);
      const transcript = normal.value;

      // —— 正对照：画面确实渲染出来了 ——
      expect(transcript.frames.length > 0, "TUI 一帧都没渲染出来");
      const lastFrame = transcript.frames[transcript.frames.length - 1];
      if (lastFrame === undefined) fatal("TUI 没有最后一帧");
      expect(lastFrame.text.includes(marker), "画面里看不到刚敲进去的那句话");

      // —— 流式回复 ——
      expect(
        transcript.streamChunks.length >= 2,
        `流式回复只有 ${transcript.streamChunks.length} 个增量——不是流式吐出`,
      );
      const joined = transcript.streamChunks.join("");
      expect(joined.trim().length > 0, "流式增量拼起来是空的");
      expect(lastFrame.text.includes(joined), "流式增量拼起来的内容没出现在最终画面里");

      // —— 只有一条会话，没有会话列表（D9 / D11 四） ——
      const stray = transcript.frames.filter((frame) => frame.sessionCount !== 1);
      expect(
        stray.length === 0,
        `有 ${stray.length} 帧画面上的会话数不是 1——D9 一位住户一条主流，不摆会话列表`,
      );

      // —— 当前是哪位住户、哪个模型 ——
      expect(
        transcript.statusResidentId === RESIDENT,
        `状态栏住户是 ${String(transcript.statusResidentId)}，应为 ${RESIDENT}——看不清现在跟谁说话就判红`,
      );
      expect(
        transcript.statusModel === CHANNEL_A.model,
        `状态栏模型是 ${String(transcript.statusModel)}，应为 ${CHANNEL_A.model}`,
      );

      // —— 错误看得见，不静默 ——
      const broken = await driver.tuiTranscript({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        script: [
          { kind: "breakChannel" },
          { kind: "input-after-break", text: markerFor("RT-05", "boom") },
        ],
      });
      if (!broken.ok) fatal(`TUI 故障脚本跑不完：${broken.error.code} ${broken.error.message}`);
      expect(
        broken.value.errorText !== null && broken.value.errorText.trim().length > 0,
        "通道坏了画面却没有任何错误呈现——静默失败",
      );

      return pass(
        `${transcript.frames.length} 帧、会话数恒 1、流式 ${transcript.streamChunks.length} 个增量拼接出现在末帧；` +
          `状态栏 ${String(transcript.statusResidentId)} / ${String(transcript.statusModel)}；` +
          `通道故障呈现为 ${broken.value.errorText === null ? "无" : `${broken.value.errorText.length} 字错误`}`,
      );
    },
  },

  {
    id: "RT-06",
    title: "凭证：密钥只走环境变量或凭证引用，日志、一窗流、交接信里不出现明文",
    uses: ["provisionChannel", "say", "secretScan"],
    async run(driver) {
      const RESIDENT = residentFor("RT-06");
      const provisioned = await driver.provisionChannel({
        residentId: RESIDENT,
        channel: CHANNEL_A,
        canarySecret: CANARY_SECRET,
      });
      if (!provisioned.ok) fatal(`配通道失败：${provisioned.error.code}`);

      // —— 凭证引用不是明文 ——
      expect(
        provisioned.value.credentialRef.trim().length > 0,
        "provisionChannel 没给出 credentialRef——RT-06 要求密钥只走环境变量或凭证引用",
      );
      expect(
        provisioned.value.credentialRef !== CANARY_SECRET,
        "credentialRef 就是密钥明文——这是引用字段，不许把原文放这儿",
      );

      // —— 正对照：扫描器确实覆盖了一窗流这个面 ——
      const marker = markerFor("RT-06", "probe");
      const said = await driver.say({ residentId: RESIDENT, text: marker });
      if (!said.ok) fatal(`say 失败：${said.error.code}`);
      const positive = await driver.secretScan({ residentId: RESIDENT, needle: marker });
      if (!positive.ok) fatal(`扫描失败：${positive.error.code}`);
      expect(
        positive.value.hits.length > 0,
        "拿一段刚落进一窗流的确定文本去扫，却一个命中都没有——扫描器空转，这盏灯等于没验",
      );
      expect(
        positive.value.hits.some((hit) => hit.surface === "stream"),
        `正对照的命中面是 ${positive.value.hits.map((hit) => hit.surface).join("、")}，里面没有 stream——扫描器没覆盖一窗流`,
      );

      // —— 主断言：蜜罐密钥哪儿都没漏 ——
      const leaked = await driver.secretScan({ residentId: RESIDENT, needle: CANARY_SECRET });
      if (!leaked.ok) fatal(`扫描失败：${leaked.error.code}`);
      expect(
        leaked.value.hits.length === 0,
        `蜜罐密钥漏在了 ${leaked.value.hits.map((hit) => hit.surface).join("、")}——AGENTS.md：密钥永远走环境变量，不进快照`,
      );

      return pass(
        `credentialRef ${provisioned.value.credentialRef.length} 字且不等于明文；` +
          `正对照（${marker.slice(0, 16)}…）命中 ${positive.value.hits.length} 处含 stream 面；` +
          `蜜罐密钥命中 ${leaked.value.hits.length} 处`,
      );
    },
  },

  {
    id: "RT-07",
    title: "真源：一窗流、交接信、启动包各只有一份实现定义，走 pi 扩展时同样适用",
    uses: ["auditRoots"],
    async run(driver) {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "mist-rt07-"));
      try {
        // —— 正对照一：干净树报零 findings。这一步同时证明方法门面、普通调用与别名
        //    调用都不被当成第二份实现（#200 审读第 2 条指出的假红 / 假绿） ——
        const cleanRoot = join(fixtureRoot, "clean");
        writeFixtureTree(cleanRoot, { "assemble.ts": CLEAN_FIXTURE });
        const clean = auditResidentRuntimeWriteSurface([cleanRoot]);
        expect(
          clean.findings.length === 0,
          `干净夹具树报了 ${clean.findings.length} 条 findings（${clean.findings
            .map((finding) => `${finding.surface}:${finding.kind}`)
            .join("、")}）——审计把门面或调用当成了实现，判据不成立`,
        );

        // —— 正对照二：零定义的树三个面都报 missing ——
        const emptyRoot = join(fixtureRoot, "empty");
        writeFixtureTree(emptyRoot, { "idle.ts": EMPTY_FIXTURE });
        const empty = auditResidentRuntimeWriteSurface([emptyRoot]);
        for (const surface of WRITE_PATH_SURFACES) {
          expect(
            empty.findings.some(
              (finding) => finding.kind === "write-path-missing" && finding.surface === surface,
            ),
            `空树没给 ${surface} 报 write-path-missing——审计漏了这一面`,
          );
        }

        // —— 正对照三：第二份定义藏进 pi 扩展根照样被判（「走 pi 扩展时同样适用」） ——
        const srcFixture = join(fixtureRoot, "src-fixture");
        const extensionFixture = join(fixtureRoot, "pi-extension");
        writeFixtureTree(srcFixture, { "host.ts": HALF_FIXTURE });
        writeFixtureTree(extensionFixture, { "extension.ts": HALF_FIXTURE });
        const single = auditResidentRuntimeWriteSurface([srcFixture]);
        expect(
          single.findings.length === 0,
          `单根夹具（每面一次定义）报了 ${single.findings.length} 条 findings——唯一性判据算错了`,
        );
        const withExtension = auditResidentRuntimeWriteSurface([srcFixture, extensionFixture]);
        for (const surface of WRITE_PATH_SURFACES) {
          const marker = WRITE_PATH_MARKERS[surface];
          const finding = withExtension.findings.find(
            (item) => item.kind === "write-path-duplicated" && item.surface === surface,
          );
          if (finding === undefined) {
            fatal(`pi 扩展里那份 ${marker} 没被判成第二份写入路径——审计不看扩展目录`);
          }
          expect(
            finding.detail.includes("extension.ts"),
            `${surface} 的重复报告没点到扩展目录里的那份：${finding.detail}`,
          );
        }

        // —— 主断言：真实源码树。src/ 永远在检索范围内，驱动只能加根 ——
        const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
        const extraRoots = await driver.auditRoots();
        const real = auditResidentRuntimeWriteSurface([sourceRoot, ...extraRoots]);
        if (real.findings.length > 0) {
          return fail(
            `写入路径不唯一：${real.findings.map((finding) => finding.detail).join("；")}`,
          );
        }

        const summary = real.paths
          .map((path) => `${path.surface}(${path.marker} × ${path.definitions.length} 定义)`)
          .join("、");
        return pass(
          `检索 ${real.roots.length} 个根（src/ ${extraRoots.length > 0 ? `+ ${extraRoots.length} 个扩展根` : "，无扩展根"}）；` +
            `${summary}；正对照三组（干净树 0 findings、空树 3 missing、扩展根 3 duplicated）全中`,
        );
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  },
];
