/**
 * #194 住户运行时的单元测试：测试跟着功能走（仓规六）。
 *
 * 覆盖面：通道映射（D25 三）、凭证面（RT-06 存而不漏）、循环落账纪律
 * （RT-01 成功才落账 / RT-02 跨重启只追加）、失败机器可分（credential-missing
 * vs credential-invalid vs channel-unavailable）、住户号显式入口的撞号防线。
 * 端到端判卷归 acceptance/resident-runtime-*.ts，这里只钉单元行为。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BootPackView,
  BreatheOutcome,
  LetterTimeline,
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
import { FactLedger } from "../src/store/fact-ledger.ts";
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
      adapterId: "pi-ai",
      model: "model-alpha",
      text: "敏感原文-abc",
      bootPack: { residentId: "r-synth", identity: "r-synth", commitments: [], memories: [] },
      history: [],
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

describe("回合语义（验收席复核三处 + 两项观察）", () => {
  function runtimeWith(
    transport: ModelTransport,
    options: { factLedger?: FactLedger } = {},
  ): ResidentRuntime {
    return new ResidentRuntime({ dataDir: tempDir(), transport, ...options });
  }

  /** 非确定性传输替身：第 n 次调用回「回复-n」——两次调用必不同，专钉回执语义。 */
  function countingTransport(reply: (n: number, text: string) => string): {
    transport: ModelTransport;
    calls: () => number;
    requests: ModelCompletionRequest[];
  } {
    let calls = 0;
    const requests: ModelCompletionRequest[] = [];
    return {
      transport: {
        async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
          calls += 1;
          requests.push(request);
          yield reply(calls, request.text);
        },
      },
      calls: () => calls,
      requests,
    };
  }

  it("完整启动包与一窗流上下文随请求进模型：记忆、现行事实、上一轮对话可见（意见 1）", async () => {
    const { ledger, systemWriter } = FactLedger.create();
    ledger.createLedger("r-full");
    systemWriter.append(
      "r-full",
      { author: "system", kind: "confirmed_preference", body: "住户偏好短句回复" },
      "测试备账：给请求级核对喂一条现行事实",
    );
    const stub = countingTransport(() => "收到。");
    // 记忆先进住户档案，再开运行时（运行时的住户面从同一个 residents/ 快照读）。
    const dataDir = tempDir();
    const stores = new ResidentStore({ dataDir: join(dataDir, "residents") });
    stores.createResident("小满", { residentId: "r-full" });
    stores.remember("r-full", "爱吃苹果");
    const runtime = new ResidentRuntime({ dataDir, transport: stub.transport, factLedger: ledger });
    try {
      runtimeProvision(runtime, "r-full");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-full", text: "早安" }));
      // 传输替身上的直接断言（意见 1 的验收口径）：不是在 bootPack() 读口验证。
      const first = stub.requests[0];
      expect(first?.adapterId).toBe("pi-claude-bridge");
      expect(first?.bootPack.memories.map((entry) => entry.content)).toContain("爱吃苹果");
      expect(first?.bootPack.currentFacts?.map((fact) => fact.body)).toContain("住户偏好短句回复");
      expect(first?.history).toEqual([]);
      unwrap<TurnResult>(await runtime.say({ residentId: "r-full", text: "再聊" }));
      expect(stub.requests[1]?.history).toEqual([
        { role: "user", text: "早安" },
        { role: "assistant", text: "收到。" },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("没接账的运行时：currentFacts 缺席即「没接账」，不编码成空数组（意见 1）", async () => {
    const stub = countingTransport(() => "好。");
    const runtime = runtimeWith(stub.transport);
    try {
      runtimeProvision(runtime, "r-nofacts");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-nofacts", text: "在吗" }));
      expect(stub.requests[0]?.bootPack.currentFacts).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("同一住户的完整回合串行：并发 say() 不拆散、不交错（意见 2）", async () => {
    let inFlight = 0;
    const transport: ModelTransport = {
      async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
        inFlight += 1;
        // 同户的模型调用若并发，这里就是 2——直接判红（回合必须串行）。
        expect(inFlight).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield `回复:${request.text}`;
        inFlight -= 1;
      },
    };
    const runtime = runtimeWith(transport);
    try {
      runtimeProvision(runtime, "r-seq");
      const [first, second] = await Promise.all([
        runtime.say({ residentId: "r-seq", text: "甲" }),
        runtime.say({ residentId: "r-seq", text: "乙" }),
      ]);
      expect(unwrap<TurnResult>(first).reply).toBe("回复:甲");
      expect(unwrap<TurnResult>(second).reply).toBe("回复:乙");
      const events = unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-seq" })).events;
      expect(events.map((event) => event.text)).toEqual(["甲", "回复:甲", "乙", "回复:乙"]);
    } finally {
      await runtime.close();
    }
  });

  it("已完成回合的同 turnId 重试：模型不再调用、回合不重复、回放已记录结果（意见 3）", async () => {
    const stub = countingTransport((n) => `回复-${n}`);
    const runtime = runtimeWith(stub.transport);
    try {
      runtimeProvision(runtime, "r-receipt");
      const first = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-receipt", text: "hi", turnId: "turn-t1" }),
      );
      expect(first.reply).toBe("回复-1");
      expect(stub.calls()).toBe(1);
      const retry = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-receipt", text: "hi", turnId: "turn-t1" }),
      );
      // 非确定性替身第二次会回「回复-2」：回放必须是已记录原话，不重新生成。
      expect(retry.reply).toBe("回复-1");
      expect(stub.calls()).toBe(1);
      const events = unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-receipt" })).events;
      expect(events.length).toBe(2);
    } finally {
      await runtime.close();
    }
  });

  it("同 turnId 不同文本 = 结构化锚冲突 fail-closed：不开新回合、不冒充 writer 故障（协助审查 1）", async () => {
    const stub = countingTransport((n) => `回复-${n}`);
    const runtime = runtimeWith(stub.transport);
    try {
      runtimeProvision(runtime, "r-anchor");
      const one = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-anchor", text: "第一条", turnId: "turn-x" }),
      );
      expect(one.reply).toBe("回复-1");
      // 锚复用于不同文本是调用方 bug：fail-closed 报**独立错误码**（验收席
      // 5312646838：机器可分判据是 code，自由文本不算），不悄悄换锚开新回合。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const conflict = await runtime.say({
          residentId: "r-anchor",
          text: "第二条",
          turnId: "turn-x",
        });
        expect(failureOf(conflict)).toMatchObject({ code: "turn-id-conflict" });
        expect(failureOf(conflict).remedy).toContain("turnId"); // remedy 指路可操作
      }
      expect(stub.calls()).toBe(1); // 报错在模型调用之前：「第二条」三次都没送进模型
      const events = unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-anchor" })).events;
      expect(events.map((event) => event.text)).toEqual(["第一条", "回复-1"]); // 流水不增、不留孤儿
    } finally {
      await runtime.close();
    }
  });

  it("扫描面文件名公约：全等 residentId 或 `residentId.` 开头，否则判红（协助审查 2）", async () => {
    const stub = countingTransport(() => "好。");
    const dataDir = tempDir();
    const runtime = new ResidentRuntime({ dataDir, transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-a");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-a", text: "封面" }));
      unwrap<BootPackView>(runtime.bootPack({ residentId: "r-a" }));
      // 扫描面（streams/residents/letters/logs）上的每个文件名都必须能被按户界
      // 的扫描匹配到：全等 residentId 或以 `residentId.` 开头。不符合的名字会从
      // 扫描面漏掉 → RT-06 假绿，所以这里判红（钉命名公约，防未来文件名漏扫）。
      for (const surface of ["streams", "residents", "letters", "logs"]) {
        const dir = join(dataDir, surface);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
          expect(
            file === "r-a" || file.startsWith("r-a."),
            `扫描面 ${surface}/${file} 不符合命名公约（全等 residentId 或 residentId. 开头），会漏扫`,
          ).toBe(true);
        }
      }
    } finally {
      await runtime.close();
    }
  });

  it("凭证吊销后：结构化 credential-invalid、模型零调用（观察 A 收口）", async () => {
    const stub = countingTransport(() => "不该出现");
    const runtime = runtimeWith(stub.transport);
    try {
      runtimeProvision(runtime, "r-rvk");
      runtime.revokeCredential({ residentId: "r-rvk" });
      const result = await runtime.say({ residentId: "r-rvk", text: "还听得见吗" });
      expect(failureOf(result)).toMatchObject({ code: "credential-invalid" });
      // 密钥闸在模型之前：零调用，不是「调了被拒」。find/readSecret 之间的 revoke
      // 竞态由 say() 的读取兜底落同一结构化码（窗口太小没法单测，结构上收口）。
      expect(stub.calls()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("清单丢失而密钥还在：fail-closed 拒绝清扫、密钥文件不被删（观察 B）", () => {
    const root = join(tempDir(), "credentials");
    const store = new CredentialStore(root);
    const record = store.provision({
      residentId: "r-keep",
      channel: claudeChannel,
      secret: "sk-keep-1",
    });
    const secretPath = join(
      root,
      "secrets",
      `${record.credentialRef.slice("mist-cred:".length)}.key`,
    );
    expect(existsSync(secretPath)).toBe(true);
    rmSync(join(root, "manifest.json"));
    expect(() => new CredentialStore(root)).toThrow(/manifest missing/);
    // 现场留着等人裁：不静默毁掉可能是唯一的凭证副本。
    expect(existsSync(secretPath)).toBe(true);
  });
});

describe("换气与交接信（RT-03 / D8）", () => {
  function fresh(): ResidentRuntime {
    return new ResidentRuntime({ dataDir: tempDir(), transport: new SyntheticModelTransport() });
  }

  it("breathe：每代一封、签名是换代前那代、窗号逐字不变、启动包注入同形原件", async () => {
    const runtime = fresh();
    try {
      runtimeProvision(runtime, "r-air");
      expect(
        runtime.setBreathThreshold({
          residentId: "r-air",
          windowId: "w-air",
          generation: 1,
          thresholdTokens: Number.MAX_SAFE_INTEGER,
          authority: "window",
        }).ok,
      ).toBe(true);
      const one = unwrap<TurnResult>(await runtime.say({ residentId: "r-air", text: "第一句" }));
      expect(one.generation).toBe(1);
      const breathed = unwrap<BreatheOutcome>(
        await runtime.breathe({ residentId: "r-air", via: "clear" }),
      );
      expect(breathed.fromGeneration).toBe(1);
      expect(breathed.toGeneration).toBe(2);
      expect(breathed.windowId).toBe("w-air"); // 换气前后逐字不变（MV-D10 同族）
      expect(breathed.letter.author).toBe("r-air#1"); // 签名是换代前那代
      const timeline = unwrap<LetterTimeline>(runtime.letterTimeline({ residentId: "r-air" }));
      expect(timeline.letters).toHaveLength(1); // 每代恰好一封
      const pack = unwrap<BootPackView>(runtime.bootPack({ residentId: "r-air" }));
      expect(pack.letter?.title).toBe(breathed.letter.title); // 注入原件同形
    } finally {
      await runtime.close();
    }
  });

  it("触发线：回合起后窗无权改线（breath-refused），主人改线从下一代生效", async () => {
    const runtime = fresh();
    try {
      runtimeProvision(runtime, "r-line");
      runtime.setBreathThreshold({
        residentId: "r-line",
        windowId: "w-line",
        generation: 1,
        thresholdTokens: Number.MAX_SAFE_INTEGER,
        authority: "window",
      });
      const said = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-line", text: "开了个头" }),
      );
      const refused = runtime.setBreathThreshold({
        residentId: "r-line",
        windowId: "w-line",
        generation: said.generation,
        thresholdTokens: 500,
        authority: "window",
      });
      expect(failureOf(refused)).toMatchObject({ code: "breath-refused" });
      // 主人能改；但从下一代生效——这一代的线还是高线，不自动换气。
      expect(
        runtime.setBreathThreshold({
          residentId: "r-line",
          windowId: "w-line",
          generation: said.generation,
          thresholdTokens: 1,
          authority: "owner",
        }).ok,
      ).toBe(true);
      const second = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-line", text: "再来一句" }),
      );
      expect(second.generation).toBe(1); // 主人的低线还没生效，这代不换
      const breathed = unwrap<BreatheOutcome>(
        await runtime.breathe({ residentId: "r-line", via: "new" }),
      );
      expect(breathed.toGeneration).toBe(2);
      // 新一代按主人的低线走：这句到线、自动换气落信。
      const third = unwrap<TurnResult>(await runtime.say({ residentId: "r-line", text: "到线句" }));
      expect(third.generation).toBe(2);
      const timeline = unwrap<LetterTimeline>(runtime.letterTimeline({ residentId: "r-line" }));
      expect(timeline.letters.length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.close();
    }
  });

  it("猝死：不写信换继任者，死代流水归档按代可查、查不到 fail-closed", async () => {
    const runtime = fresh();
    try {
      runtimeProvision(runtime, "r-dead");
      const dead = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-dead", text: "临终的话" }),
      );
      await runtime.suddenDeath({ residentId: "r-dead" });
      const successor = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-dead", text: "继任者报到" }),
      );
      expect(successor.generation).toBeGreaterThan(dead.generation); // 真换了继任者
      const archived = unwrap<StreamSnapshot>(
        runtime.archivedTranscript({ residentId: "r-dead", generation: dead.generation }),
      );
      // D8 三的正面：死代流水没有无声消失，归档里按代查得到。
      expect(archived.events.some((event) => event.text.includes("临终的话"))).toBe(true);
      // 查不到的代 fail-closed，不拿空快照冒充「这代没有流水」。
      const missing = runtime.archivedTranscript({ residentId: "r-dead", generation: 99 });
      expect(failureOf(missing)).toMatchObject({ code: "stream-not-found" });
    } finally {
      await runtime.close();
    }
  });

  it("到线自动换气：低线 say 落账后亲笔写信换代，回执报换代前那代", async () => {
    const runtime = fresh();
    try {
      runtimeProvision(runtime, "r-auto");
      runtime.setBreathThreshold({
        residentId: "r-auto",
        windowId: "w-auto",
        generation: 1,
        thresholdTokens: 1,
        authority: "window",
      });
      const said = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-auto", text: "这句就到线" }),
      );
      expect(said.generation).toBe(1); // 回执报换代前那代（补记一）
      const timeline = unwrap<LetterTimeline>(runtime.letterTimeline({ residentId: "r-auto" }));
      expect(timeline.letters).toHaveLength(1);
      expect(timeline.letters[0]?.author).toBe("r-auto#1");
    } finally {
      await runtime.close();
    }
  });

  it("换代不插回合中途：并发 say + breathe 在同一串行域（协助审查严重项）", async () => {
    // 慢速传输：没有串行域的话，breathe 会插进模型等待的中途，回合拆两代。
    const runtime = new ResidentRuntime({
      dataDir: tempDir(),
      transport: {
        async *complete(): AsyncIterable<string> {
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield "慢回复";
        },
      },
    });
    try {
      runtimeProvision(runtime, "r-race");
      const [said, breathed] = await Promise.all([
        runtime.say({ residentId: "r-race", text: "回合句" }),
        runtime.breathe({ residentId: "r-race", via: "new" }),
      ]);
      const turn = unwrap<TurnResult>(said);
      const swap = unwrap<BreatheOutcome>(breathed);
      // 回合完整落在一代里：user/assistant 不许拆在旧代/新代两边。
      const events = unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-race" })).events;
      expect(events.map((event) => event.text)).toEqual(["回合句", "慢回复"]);
      // say 先排队：换代发生在整个回合之后，fromGeneration 正是回合那代。
      expect(swap.fromGeneration).toBe(turn.generation);
    } finally {
      await runtime.close();
    }
  });

  it("主人改线任何时刻可收（哪怕代际是旧账面），pending 从下一代生效（协助审查中等项）", async () => {
    const runtime = fresh();
    try {
      runtimeProvision(runtime, "r-owner");
      runtime.setBreathThreshold({
        residentId: "r-owner",
        windowId: "w-owner",
        generation: 1,
        thresholdTokens: Number.MAX_SAFE_INTEGER,
        authority: "window",
      });
      // 代际 999 是调用方的旧账面：主人改配置照收，不校验当前代。
      const retune = runtime.setBreathThreshold({
        residentId: "r-owner",
        windowId: "w-owner",
        generation: 999,
        thresholdTokens: 1,
        authority: "owner",
      });
      expect(retune.ok).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("窗号认领落盘：重启后不许换号（协助审查中等项）", async () => {
    const dataDir = tempDir();
    const first = new ResidentRuntime({ dataDir, transport: new SyntheticModelTransport() });
    runtimeProvision(first, "r-pin");
    expect(
      first.setBreathThreshold({
        residentId: "r-pin",
        windowId: "w-pin-1",
        generation: 1,
        thresholdTokens: Number.MAX_SAFE_INTEGER,
        authority: "window",
      }).ok,
    ).toBe(true);
    await first.close();
    const second = new ResidentRuntime({ dataDir, transport: new SyntheticModelTransport() });
    try {
      const renames = second.setBreathThreshold({
        residentId: "r-pin",
        windowId: "w-pin-2",
        generation: 1,
        thresholdTokens: Number.MAX_SAFE_INTEGER,
        authority: "window",
      });
      // 认领在盘上，重启也换不了号。
      expect(failureOf(renames)).toMatchObject({ code: "breath-refused" });
    } finally {
      await second.close();
    }
  });

  it("信档损坏 fail-closed：不静默回退旧信（协助审查轻微项）", async () => {
    const dataDir = tempDir();
    const runtime = new ResidentRuntime({ dataDir, transport: new SyntheticModelTransport() });
    try {
      runtimeProvision(runtime, "r-bad");
      unwrap<BreatheOutcome>(await runtime.breathe({ residentId: "r-bad", via: "new" }));
      writeFileSync(join(dataDir, "letters", "r-bad.letter-2.json"), "{ broken", "utf8");
      const timeline = runtime.letterTimeline({ residentId: "r-bad" });
      // 报损坏，不装作没这封。
      expect(failureOf(timeline)).toMatchObject({ code: "letter-invalid" });
      // 启动包同样不静默降级到旧信。
      const pack = runtime.bootPack({ residentId: "r-bad" });
      expect(failureOf(pack)).toMatchObject({ code: "letter-invalid" });
    } finally {
      await runtime.close();
    }
  });

  it("校验失败的设线不钉窗号：认领只在全过之后（协助审查尾巴）", async () => {
    const runtime = fresh();
    try {
      runtimeProvision(runtime, "r-tail");
      // 非法触发线：调用失败。
      const bad = runtime.setBreathThreshold({
        residentId: "r-tail",
        windowId: "w-tail-bad",
        generation: 1,
        thresholdTokens: 0,
        authority: "window",
      });
      expect(failureOf(bad)).toMatchObject({ code: "breath-refused" });
      // 失败的调用不许把窗号钉死：换一个窗号重发合法设线，必须收。
      const good = runtime.setBreathThreshold({
        residentId: "r-tail",
        windowId: "w-tail-good",
        generation: 1,
        thresholdTokens: Number.MAX_SAFE_INTEGER,
        authority: "window",
      });
      expect(good.ok).toBe(true);
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
