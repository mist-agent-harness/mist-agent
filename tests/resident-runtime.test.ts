/**
 * #194 住户运行时的单元测试：测试跟着功能走（仓规六）。
 *
 * 覆盖面：通道映射（D25 三）、凭证面（RT-06 存而不漏）、循环落账纪律
 * （RT-01 成功才落账 / RT-02 跨重启只追加）、失败机器可分（credential-missing
 * vs credential-invalid vs channel-unavailable）、住户号显式入口的撞号防线。
 * 端到端判卷归 acceptance/resident-runtime-*.ts，这里只钉单元行为。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BootPackView,
  Result,
  StreamSnapshot,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";
import { type CanonicalEventDraft, CanonicalStreamStore } from "../src/one-stream/index.ts";
import {
  ChannelSpecError,
  type ChannelSpecLike,
  type ModelCompletionRequest,
  type ModelTransport,
  SyntheticModelTransport,
  resolveChannelRoute,
} from "../src/resident-runtime/channels.ts";
import { CredentialStore } from "../src/resident-runtime/credentials.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";
import { ResidentStore } from "../src/store/resident-store.ts";
import { openCanonicalStreamWriter } from "../src/window-host/window-history-host.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-resident-runtime-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`预期成功却失败了：${result.error.code} ${result.error.message}`);
  return result.value;
}

function failureOf<T>(result: Result<T>): { code: string; remedy: string } {
  if (result.ok) throw new Error("预期失败却成功了");
  return { code: result.error.code, remedy: result.error.remedy };
}

const claudeChannel: ChannelSpecLike = {
  claudeSubscription: true,
  credentialKind: "subscription",
  model: "model-alpha",
};

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

describe("通道映射（D25 三：Claude 订阅是唯一特例）", () => {
  it("订阅走 pi-claude-bridge、其余走 pi-ai", () => {
    expect(resolveChannelRoute(claudeChannel).adapterId).toBe("pi-claude-bridge");
    expect(
      resolveChannelRoute({ claudeSubscription: false, credentialKind: "api-key", model: "m1" })
        .adapterId,
    ).toBe("pi-ai");
  });

  it("口径接反或模型为空就抛 ChannelSpecError——映射是判据，接反即错", () => {
    expect(() => resolveChannelRoute({ ...claudeChannel, credentialKind: "api-key" })).toThrow(
      ChannelSpecError,
    );
    expect(() =>
      resolveChannelRoute({
        claudeSubscription: false,
        credentialKind: "subscription",
        model: "m",
      }),
    ).toThrow(ChannelSpecError);
    expect(() => resolveChannelRoute({ ...claudeChannel, model: "  " })).toThrow(ChannelSpecError);
  });

  it("合成通道确定性吐 ≥2 个增量、不复读用户原文、空密钥 fail-closed", async () => {
    const transport = new SyntheticModelTransport();
    const request: ModelCompletionRequest = {
      residentId: "r-synth",
      model: "model-alpha",
      text: "敏感原文-abc",
      bootPack: { residentId: "r-synth", identity: "r-synth", commitments: [] },
      credentialSecret: "sk-canary-1",
    };
    const chunks: string[] = [];
    for await (const chunk of transport.complete(request)) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join("")).toContain("合成回声");
    expect(chunks.join("")).not.toContain("敏感原文-abc");

    await expect(async () => {
      for await (const chunk of transport.complete({ ...request, credentialSecret: "" }))
        void chunk;
    }).rejects.toThrow(/empty credential/);
  });
});

describe("凭证面（RT-06 存而不漏）", () => {
  it("密钥落 0600 私有文件，清单只有 mist-cred 引用", () => {
    const root = join(tempDir(), "credentials");
    const store = new CredentialStore(root);
    const secret = "sk-canary-secret-9";
    const record = store.provision({ residentId: "r-demo", channel: claudeChannel, secret });
    expect(record.credentialRef).toMatch(/^mist-cred:[a-z0-9._-]+$/);
    expect(record.credentialRef).not.toContain(secret);
    expect(store.readSecret(record.credentialRef)).toBe(secret);

    // 全目录只有一个文件装着密钥原文，且权限恰好 0600；其余文件一个字节都不许有。
    const carriers = listFiles(root).filter((file) => readFileSync(file, "utf8").includes(secret));
    expect(carriers).toHaveLength(1);
    const mode = statSync(carriers[0] as string).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("吊销只翻状态不删档：后续说话说 credential-invalid 而不是 credential-missing", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      runtime.provisionChannel({
        residentId: "r-rev",
        channel: claudeChannel,
        canarySecret: "sk-1",
      });
      runtime.revokeCredential({ residentId: "r-rev" });
      const result = await runtime.say({ residentId: "r-rev", text: "还在吗" });
      expect(failureOf(result).code).toBe("credential-invalid");
    } finally {
      await runtime.close();
    }
  });
});

describe("住户运行时循环（RT-01 / RT-02）", () => {
  it("say 往返成功才落账：user → assistant 两条事件、流文件恰好一个、扫描面干净", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      const provisioned = runtime.provisionChannel({
        residentId: "r-a",
        channel: claudeChannel,
        canarySecret: "sk-canary-1",
      });
      expect(provisioned.ok).toBe(true);
      const turn = unwrap<TurnResult>(await runtime.say({ residentId: "r-a", text: "第一句" }));
      expect(turn.streamed).toBe(true);
      expect(turn.generation).toBe(1);
      expect(turn.reply.trim().length).toBeGreaterThan(0);

      const snapshot = unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-a" }));
      expect(snapshot.events).toHaveLength(2);
      expect(snapshot.events[0]?.payloadHash).not.toBe("");
      expect(snapshot.events[0]?.streamSeq).toBeGreaterThan(0);

      const inventory = unwrap(runtime.streamFiles());
      expect(inventory.files).toHaveLength(1);
      expect(inventory.files[0]?.endsWith(".stream.json")).toBe(true);

      const scan = unwrap(runtime.secretScan({ residentId: "r-a", needle: "sk-canary-1" }));
      expect(scan.hits).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("跨进程重启同一条主流：旧事件逐条不变、只追加、同窗接代（代际递增）", async () => {
    const dataDir = tempDir();
    const first = new ResidentRuntime({ dataDir });
    try {
      runtimeProvision(first, "r-b");
      const turn1 = unwrap<TurnResult>(await first.say({ residentId: "r-b", text: "早安" }));
      expect(turn1.generation).toBe(1);
    } finally {
      await first.close();
    }

    const second = new ResidentRuntime({ dataDir });
    try {
      const before = unwrap<StreamSnapshot>(second.readStream({ residentId: "r-b" }));
      expect(before.events).toHaveLength(2);
      const turn2 = unwrap<TurnResult>(await second.say({ residentId: "r-b", text: "晚安" }));
      // 同一 windowId 重开 = 新一代（宿主硬杀即猝死，继任者接代）。
      expect(turn2.generation).toBe(2);
      const after = unwrap<StreamSnapshot>(second.readStream({ residentId: "r-b" }));
      expect(after.events).toHaveLength(4);
      // 只追加：前两条逐字不变（id、序号、hash 都不许动）。
      expect(after.events.slice(0, 2)).toEqual(before.events);
    } finally {
      await second.close();
    }
  });

  it("失败不落账、三类失败机器可分：never-配过 / 被吊销 / 通道挂了", async () => {
    const broken: ModelTransport = {
      async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
        void request;
        // useYield 要求生成器里有 yield：吐一个空增量后断流，语义同「上游跑了半截」。
        yield "";
        throw new Error("上游断了");
      },
    };
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: broken });
    try {
      const missing = await runtime.say({ residentId: "r-c", text: "x" });
      expect(failureOf(missing)).toMatchObject({ code: "credential-missing" });
      expect(failureOf(missing).remedy.length).toBeGreaterThan(0);

      runtimeProvision(runtime, "r-d");
      const failed = await runtime.say({ residentId: "r-d", text: "y" });
      expect(failureOf(failed).code).toBe("channel-unavailable");
      // 往返失败一条都不落：流根本不存在（不伪造读回）。
      const snapshot = runtime.readStream({ residentId: "r-d" });
      expect(failureOf(snapshot).code).toBe("stream-not-found");
    } finally {
      await runtime.close();
    }
  });

  it("启动包装配唯一、没换过代就没有信（letter 为 null，不拿空信占位）", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      runtimeProvision(runtime, "r-e");
      const pack = unwrap<BootPackView>(runtime.bootPack({ residentId: "r-e" }));
      expect(pack.residentId).toBe("r-e");
      expect(pack.letter).toBeNull();
    } finally {
      await runtime.close();
    }
  });
});

describe("住户号显式入口（判卷与安装器指定的事实不能换号）", () => {
  it("显式住户号生效；撞号 fail-closed 拒绝覆盖；非法字符拒绝", () => {
    const store = new ResidentStore({ dataDir: join(tempDir(), "residents") });
    expect(store.createResident("哒宰", { residentId: "r-explicit" })).toBe("r-explicit");
    expect(store.has("r-explicit")).toBe(true);
    expect(() => store.createResident("别人", { residentId: "r-explicit" })).toThrow(/collision/);
    expect(() => store.createResident("坏号", { residentId: "../escape" })).toThrow(/文件名/);
  });
});

describe("评审意见修复（wusaki0723 复审：幂等重试 / 凭证读取边界 / fail-closed 读）", () => {
  it("同一 turnId 重试幂等：不写重复；不同 turnId 是独立回合（意见 1）", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      runtimeProvision(runtime, "r-retry");
      const args = { residentId: "r-retry", text: "你好", turnId: "turn-fixed-1" };
      const first = unwrap<TurnResult>(await runtime.say(args));
      const second = unwrap<TurnResult>(await runtime.say(args)); // 同回合重试
      expect(second.reply).toBe(first.reply);
      expect(
        unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-retry" })).events,
      ).toHaveLength(2);
      // 换个 turnId = 新回合：同文本也照常各落两条。
      unwrap<TurnResult>(
        await runtime.say({ residentId: "r-retry", text: "你好", turnId: "turn-fixed-2" }),
      );
      expect(
        unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-retry" })).events,
      ).toHaveLength(4);
    } finally {
      await runtime.close();
    }
  });

  it("读取边界把状态关死：revoked / 幽灵引用不放密钥原文（意见 2）", () => {
    const store = new CredentialStore(join(tempDir(), "credentials"));
    const record = store.provision({
      residentId: "r-bound",
      channel: claudeChannel,
      secret: "sk-bound-1",
    });
    store.revoke("r-bound");
    expect(() => store.readSecret(record.credentialRef)).toThrow(/refusing to release secret/);
    expect(() => store.readSecret("mist-cred:cred-ghost")).toThrow(/not in manifest/);
  });

  it("启动清扫孤儿密钥；revoked 档还挂在清单上、不扫（意见 3）", () => {
    const root = join(tempDir(), "credentials");
    const store = new CredentialStore(root);
    store.provision({ residentId: "r-sw", channel: claudeChannel, secret: "sk-sw-1" });
    // 模拟换凭证死在「清单已换、旧密钥未删」：留一个清单不引用的 key。
    writeFileSync(join(root, "secrets", "cred-orphan.key"), "sk-orphan", { mode: 0o600 });
    store.revoke("r-sw");
    const restarted = new CredentialStore(root); // 重启 = 构造即清扫
    expect(restarted.find("r-sw")?.status).toBe("revoked");
    const remaining = readdirSync(join(root, "secrets")).sort();
    expect(remaining).not.toContain("cred-orphan.key");
    expect(remaining).toHaveLength(1); // revoked 记录自己的档还在：revoke 不删档
  });

  it("读到本层读不懂的事件 fail-closed，不猜不标 assistant（意见 4）", async () => {
    const dataDir = tempDir();
    const streams = new CanonicalStreamStore({ dataDir: join(dataDir, "streams") });
    streams.createStream("r-foreign");
    const writer = openCanonicalStreamWriter(streams);
    await writer.submit({
      residentId: "r-foreign",
      idempotencyKey: "foreign-1",
      draft: foreignDraft(),
    });
    await writer.close();
    const runtime = new ResidentRuntime({ dataDir });
    try {
      expect(() => runtime.readStream({ residentId: "r-foreign" })).toThrow(/读不懂/);
    } finally {
      await runtime.close();
    }
  });

  it("空文本在 runtime 层也拦，不等 IPC（意见 4）", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      const result = await runtime.say({ residentId: "r-empty", text: "   " });
      expect(failureOf(result)).toMatchObject({ code: "channel-unavailable" });
    } finally {
      await runtime.close();
    }
  });

  it("secretScan 按户界扫：r-a 的面不含 r-ab，正对照能命中自己的（意见 4）", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      runtimeProvision(runtime, "r-a");
      runtime.provisionChannel({
        residentId: "r-ab",
        channel: claudeChannel,
        canarySecret: "sk-r-ab",
      });
      unwrap<TurnResult>(await runtime.say({ residentId: "r-a", text: "甲说" }));
      unwrap<TurnResult>(await runtime.say({ residentId: "r-ab", text: "乙说特有词" }));
      // 反对照：扫 r-a 不许串到 r-ab 的文件。
      expect(unwrap(runtime.secretScan({ residentId: "r-a", needle: "乙说特有词" })).hits).toEqual(
        [],
      );
      // 正对照：同一个探针在自己户里真的扫得到，否则上面的空命中是假绿。
      expect(
        unwrap(runtime.secretScan({ residentId: "r-ab", needle: "乙说特有词" })).hits.length,
      ).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });
});

function foreignDraft(): CanonicalEventDraft {
  // 形状照 messageDraft，role 故意写本层读不懂的 "system"（意见 4 的反对照夹具）。
  const actor = { kind: "viewport", id: "w-foreign" } as const;
  return {
    purpose: "message",
    occurredAt: new Date(0).toISOString(),
    workRef: null,
    authoritySource: actor,
    origin: {
      reporter: actor,
      subject: { kind: "resident", id: "r-foreign" },
      viewport: { windowId: "w-foreign", generation: 1 },
    },
    effect: { state: "not-applicable", requiresUserAction: false, retry: "not-applicable" },
    artifactRef: null,
    payload: { role: "system", text: "x" },
  };
}

function runtimeProvision(runtime: ResidentRuntime, residentId: string): void {
  runtime.provisionChannel({
    residentId,
    channel: claudeChannel,
    canarySecret: `sk-${residentId}`,
  });
}
