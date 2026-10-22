import { spawn, spawnSync } from "node:child_process";
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
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BootPackView,
  BreatheOutcome,
  LetterTimeline,
  Result,
  StreamSnapshot,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";
import {
  type CanonicalEventDraft,
  CanonicalStreamStore,
  CanonicalStreamWriter,
} from "../src/one-stream/index.ts";
import { ResidentIdentityStore } from "../src/resident-continuity/identity-store.ts";
import { LetterStore } from "../src/resident-runtime/breath.ts";
import {
  ChannelSpecError,
  type ChannelSpecLike,
  type ModelCompletionRequest,
  type ModelTransport,
  SyntheticModelTransport,
  resolveChannelRoute,
} from "../src/resident-runtime/channels.ts";
import { CredentialStore } from "../src/resident-runtime/credentials.ts";
import { renderSystemPrompt } from "../src/resident-runtime/pi-transport.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";
import { sealLetter } from "../src/session/handover-letter.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";
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
  vi.restoreAllMocks();
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
      runtimeProvision(runtime, "r-rev", "sk-1");
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
      const provisioned = runtimeProvision(runtime, "r-a", "sk-canary-1");
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

  it("硬杀后重启同一条主流：旧事件逐条不变、只追加、同窗接代（代际递增）", async () => {
    const dataDir = tempDir();
    const first = new ResidentRuntime({ dataDir });
    try {
      runtimeProvision(first, "r-b");
      const turn1 = unwrap<TurnResult>(await first.say({ residentId: "r-b", text: "早安" }));
      expect(turn1.generation).toBe(1);
    } finally {
      await closeLikeHardKill(first, dataDir);
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
      activateResident(runtime, "r-c");
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

describe("#182 入住读闸", () => {
  it("requireActiveResident 只读；宿主启动单独恢复已持久化的 active room", async () => {
    const dataDir = tempDir();
    const roomPath = join(dataDir, "residents", "r-read-gate.json");
    const runtime = new ResidentRuntime({ dataDir });
    try {
      vi.spyOn(ResidentIdentityStore.prototype, "requireActiveResident").mockReturnValue({
        ok: true,
        value: {
          candidateId: "candidate-read-gate",
          residentId: "r-read-gate",
          personaVersionId: "persona-read-gate",
          persona: "persona:read-gate",
        },
      });
      expect(runtime.requireActiveResident("r-read-gate")).toMatchObject({
        ok: true,
        value: { residentId: "r-read-gate" },
      });
      expect(existsSync(roomPath)).toBe(false);
    } finally {
      await runtime.close();
      vi.restoreAllMocks();
    }

    const identities = new ResidentIdentityStore({ dataDir: join(dataDir, "identities") });
    const candidate = identities.createCandidate({
      persona: "persona:read-gate",
      proposedBy: { kind: "installer", id: "installer" },
      residentId: "r-read-gate",
    });
    expect(
      identities.attestCandidate(
        candidate.candidateId,
        { kind: "candidate", candidateId: candidate.candidateId },
        "accepted",
      ),
    ).toMatchObject({ ok: true, value: { residentId: "r-read-gate" } });
    expect(existsSync(roomPath)).toBe(false);

    const restarted = new ResidentRuntime({ dataDir });
    try {
      expect(existsSync(roomPath)).toBe(true);
      expect(restarted.requireActiveResident(candidate.candidateId)).toMatchObject({
        ok: true,
        value: { residentId: "r-read-gate" },
      });
    } finally {
      await restarted.close();
    }
  });

  it("边界读口区分 pending、rejected、missing；运行时入口只接受 canonical residentId", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      const pending = runtime.createCandidate({
        persona: "persona:pending",
        proposedBy: { kind: "installer", id: "installer" },
        residentId: "r-pending",
      });
      expect(runtime.requireActiveResident(pending.candidateId)).toEqual({
        ok: false,
        reason: "candidate-pending",
      });
      expect(
        failureOf(
          runtime.provisionChannel({
            residentId: pending.candidateId,
            channel: claudeChannel,
            canarySecret: "sk-pending",
          }),
        ).code,
      ).toBe("resident-not-found");
      runtime.attestCandidate(
        pending.candidateId,
        { kind: "candidate", candidateId: pending.candidateId },
        "rejected",
      );
      expect(runtime.requireActiveResident(pending.candidateId)).toEqual({
        ok: false,
        reason: "candidate-rejected",
      });
      expect(
        failureOf(
          runtime.provisionChannel({
            residentId: "resident-does-not-exist",
            channel: claudeChannel,
            canarySecret: "sk-missing",
          }),
        ).code,
      ).toBe("resident-not-found");
    } finally {
      await runtime.close();
    }
  });

  it("active candidate materializes its runtime room and say rechecks the canonical residentId", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      const candidate = runtime.createCandidate({
        persona: "persona:active",
        proposedBy: { kind: "installer", id: "installer" },
        residentId: "r-active",
      });
      const before = await runtime.say({ residentId: candidate.candidateId, text: "不能提前聊" });
      expect(failureOf(before).code).toBe("resident-not-found");
      const active = runtime.attestCandidate(
        candidate.candidateId,
        { kind: "candidate", candidateId: candidate.candidateId },
        "accepted",
      );
      expect(active).toMatchObject({ ok: true, value: { residentId: "r-active" } });
      expect(runtime.requireActiveResident(candidate.candidateId)).toMatchObject({
        ok: true,
        value: { residentId: "r-active" },
      });
      expect(
        failureOf(await runtime.say({ residentId: candidate.candidateId, text: "别名" })).code,
      ).toBe("resident-not-found");
      expect(
        runtime.provisionChannel({
          residentId: "r-active",
          channel: claudeChannel,
          canarySecret: "sk-active",
        }).ok,
      ).toBe(true);
      expect(
        unwrap<TurnResult>(await runtime.say({ residentId: "r-active", text: "现在可以" })),
      ).toMatchObject({ residentId: "r-active", generation: 1 });
    } finally {
      await runtime.close();
    }
  });
});

describe("#182 CLI 入住边界（真实 CLI 子进程）", () => {
  const cliPath = fileURLToPath(new URL("../src/resident-runtime/cli.ts", import.meta.url));

  function runCli(dataDir: string, reference: string) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "--resident", reference, "--data-dir", dataDir],
      {
        input: "hello\n/exit\n",
        encoding: "utf8",
        env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
        timeout: 15_000,
      },
    );
  }

  it("pending candidate：CLI 报 candidate-pending 与本人自认建议，不自动接受、不造 room", () => {
    const dataDir = tempDir();
    const identities = new ResidentIdentityStore({ dataDir: join(dataDir, "identities") });
    const candidate = identities.createCandidate({
      persona: "persona:pending-cli",
      proposedBy: { kind: "installer", id: "cli-boundary-test" },
      residentId: "resident-pending-cli",
    });
    const child = runCli(dataDir, candidate.candidateId);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(1);
    expect(child.stderr).toContain("candidate-pending");
    expect(child.stderr).toContain("self-attestation");
    expect(child.stderr).toContain("处理建议：");
    expect(child.stderr).not.toContain("没有 active resident");
    // 不自动接受：candidate 仍 pending，未落 resident，未 materialize room。
    expect(
      new ResidentIdentityStore({ dataDir: join(dataDir, "identities") }).readCandidate(
        candidate.candidateId,
      ).state,
    ).toBe("inactive");
    expect(existsSync(join(dataDir, "residents", "resident-pending-cli.json"))).toBe(false);
    // 不复制凭证、不落流。
    expect(existsSync(join(dataDir, "credentials", "manifest.json"))).toBe(false);
    expect(existsSync(join(dataDir, "streams", "resident-pending-cli.stream.json"))).toBe(false);
  });

  it("rejected candidate：CLI 报 candidate-rejected 与重提建议，不自动接受、不造 room", () => {
    const dataDir = tempDir();
    const identities = new ResidentIdentityStore({ dataDir: join(dataDir, "identities") });
    const candidate = identities.createCandidate({
      persona: "persona:rejected-cli",
      proposedBy: { kind: "installer", id: "cli-boundary-test" },
      residentId: "resident-rejected-cli",
    });
    identities.attestCandidate(
      candidate.candidateId,
      { kind: "candidate", candidateId: candidate.candidateId },
      "rejected",
    );
    const child = runCli(dataDir, candidate.candidateId);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(1);
    expect(child.stderr).toContain("candidate-rejected");
    expect(child.stderr).toContain("新的 persona candidate");
    expect(
      new ResidentIdentityStore({ dataDir: join(dataDir, "identities") }).readCandidate(
        candidate.candidateId,
      ).state,
    ).toBe("rejected");
    expect(existsSync(join(dataDir, "residents", "resident-rejected-cli.json"))).toBe(false);
    expect(existsSync(join(dataDir, "credentials", "manifest.json"))).toBe(false);
    expect(existsSync(join(dataDir, "streams", "resident-rejected-cli.stream.json"))).toBe(false);
  });
});

describe("评审意见修复（wusaki0723 复审：幂等重试 / 凭证读取边界 / fail-closed 读）", () => {
  it("ready 清单但密钥文件缺失：结构化拒绝且提示宿主修复，不把用户送回 setup", async () => {
    const dataDir = tempDir();
    let calls = 0;
    const runtime = new ResidentRuntime({
      dataDir,
      transport: {
        async *complete() {
          calls += 1;
          yield "不该发生的回复";
        },
      },
    });
    try {
      runtimeProvision(runtime, "r-secret-missing");
      const root = join(dataDir, "credentials");
      const credentials = new CredentialStore(root);
      const record = credentials.find("r-secret-missing");
      expect(record?.status).toBe("ready");
      if (record === null) throw new Error("fixture 没有配好凭证");
      const manifest = readFileSync(join(root, "manifest.json"), "utf8");
      const secretPath = join(
        root,
        "secrets",
        `${record.credentialRef.slice("mist-cred:".length)}.key`,
      );
      rmSync(secretPath);

      const result = await runtime.say({ residentId: "r-secret-missing", text: "试读" });
      expect(failureOf(result).code).toBe("credential-invalid");
      expect(failureOf(result).remedy).toContain("provisionChannel");
      expect(failureOf(result).remedy).toContain("重复 setup 不会修复");
      expect(calls).toBe(0);
      expect(failureOf(runtime.readStream({ residentId: "r-secret-missing" })).code).toBe(
        "stream-not-found",
      );
      expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe(manifest);
    } finally {
      await runtime.close();
    }
  });

  it("各缺住户读口与触发线入口给出同一入住边界，不声称 setup 会建人", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      const results: Result<unknown>[] = [
        runtime.bootPack({ residentId: "r-absent" }),
        runtime.setBreathThreshold({
          residentId: "r-absent",
          windowId: "w-absent",
          generation: 1,
          thresholdTokens: 10,
          authority: "owner",
        }),
        runtime.letterTimeline({ residentId: "r-absent" }),
      ];
      for (const result of results) {
        expect(failureOf(result).code).toBe("resident-not-found");
        expect(failureOf(result).remedy).toContain("不代替 D22 住户自认");
      }
    } finally {
      await runtime.close();
    }
  });

  it("synthetic accepted candidate 到达 credential-missing：身份闸不把安装负例挡在闸外", async () => {
    // 正对照先行：没有任何凭证的 active 住户，say 必须走到 credential-missing，
    // 而不是被身份闸的 resident-not-found 提前挡住——否则 credential-missing /
    // secret-read 这些诊断分支根本没机会发生，是一盏断言空转的假绿灯。
    const dataDir = tempDir();
    let calls = 0;
    const runtime = new ResidentRuntime({
      dataDir,
      transport: {
        async *complete() {
          calls += 1;
          yield "不该发生的回复";
        },
      },
    });
    try {
      activateResident(runtime, "r-install-boundary");
      expect(runtime.requireActiveResident("r-install-boundary").ok).toBe(true);
      const missing = await runtime.say({ residentId: "r-install-boundary", text: "试读" });
      expect(failureOf(missing).code).toBe("credential-missing");
      expect(failureOf(missing).remedy).toContain("尚未接到");
      expect(failureOf(missing).remedy).toContain("重复运行 setup");
      // 失败不伪造回复、不落账。
      expect(calls).toBe(0);
      expect(failureOf(runtime.readStream({ residentId: "r-install-boundary" })).code).toBe(
        "stream-not-found",
      );
    } finally {
      await runtime.close();
    }
  });

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
      runtimeProvision(runtime, "r-ab", "sk-r-ab");
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
    // 先经入住流程成立，再从同一个 residents/ 快照写入记忆。
    const dataDir = tempDir();
    const initializer = new ResidentRuntime({ dataDir, transport: stub.transport });
    activateResident(initializer, "r-full");
    await initializer.close();
    const stores = new ResidentStore({ dataDir: join(dataDir, "residents") });
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

/**
 * D8 补记三 —— 交接信真正随启动包到达换代后 say() 的模型请求。
 *
 * 这组回归钉的是**消费端**：不是在 `bootPack()` 只读口或 `letterTimeline()` 上验证
 * 信在不在，而是录下 say() 实际喂给 transport 的 `ModelCompletionRequest`，证明信
 * 进了发送面，并渲染捕获的真实请求核对 pi system prompt。此前 runtime 的
 * 启动包在 #runTurn 里另走一遍基础 `buildBootPack`、把信丢了，所以这些断言在修复前
 * 红、修复后绿。
 */
describe("交接信随启动包进模型请求（D8 补记三：醒来即已读）", () => {
  /** 录音传输：只录请求、确定性回一个非空回复，不碰网络。 */
  function recordingTransport(): {
    transport: ModelTransport;
    requests: ModelCompletionRequest[];
  } {
    const requests: ModelCompletionRequest[] = [];
    return {
      transport: {
        async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
          requests.push(request);
          yield "已读来信。";
        },
      },
      requests,
    };
  }

  it("手动换代后下一次 say 的请求带正确原信（标题 / 作者代际 / writtenAt / 条目原文）", async () => {
    const recorder = recordingTransport();
    const dataDir = tempDir();
    const prep = new ResidentRuntime({ dataDir, transport: recorder.transport });
    activateResident(prep, "r-ho");
    await prep.close();
    const stores = new ResidentStore({ dataDir: join(dataDir, "residents") });
    stores.remember("r-ho", "上代在做迁移");
    const runtime = new ResidentRuntime({ dataDir, transport: recorder.transport });
    try {
      runtimeProvision(runtime, "r-ho");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-ho", text: "第一代的话" }));
      // 手动换代，复用已有的信草稿与封缄流程。
      const breathed = unwrap<BreatheOutcome>(
        await runtime.breathe({ residentId: "r-ho", via: "clear" }),
      );
      // 换代后下一次 say：请求里必须带上那封信的原件。
      unwrap<TurnResult>(await runtime.say({ residentId: "r-ho", text: "第二代报到" }));
      const second = recorder.requests[1];
      if (second === undefined) throw new Error("下一代没有调用 transport");
      expect(second?.bootPack.letter).toBeDefined();
      const letter = second?.bootPack.letter;
      expect(letter?.title).toBe(breathed.letter.title);
      expect(letter?.author).toBe("r-ho#1"); // 写信的是换代前那代
      expect(letter?.writtenAt).toBe(breathed.letter.writtenAt);
      // 条目 tier 与原文照抄，不重写、不丢档。
      expect(letter?.state.map((item) => item.tier)).toEqual(
        breathed.letter.state.map((item) => item.tier),
      );
      expect(letter?.state.map((item) => item.body)).toEqual(
        breathed.letter.state.map((item) => item.body),
      );
      expect(letter?.intent.map((item) => item.body)).toEqual(
        breathed.letter.intent.map((item) => item.body),
      );
      expect(letter).toEqual(breathed.letter);
      expect(unwrap<BootPackView>(runtime.bootPack({ residentId: "r-ho" })).letter).toEqual(letter);
      const prompt = renderSystemPrompt(second);
      expect(prompt).toContain(`上一代交接信：${breathed.letter.title}`);
      expect(prompt).toContain(`作者 r-ho#1，写于 ${breathed.letter.writtenAt}`);
      for (const item of [...breathed.letter.state, ...breathed.letter.intent]) {
        expect(prompt).toContain(`- [${item.tier}] ${item.body}`);
      }
      expect(second.history).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("已有合法三档信从磁盘进入下一代的请求与最终 prompt", async () => {
    const dataDir = tempDir();
    const first = new ResidentRuntime({ dataDir, transport: new SyntheticModelTransport() });
    const state = [
      { tier: "commitment", body: "承诺每天写日报", ledgerSeq: 1 },
      { tier: "fact", body: "上代在做迁移" },
    ] as const;
    const intent = [{ tier: "judgment", body: "先核对迁移结果" }] as const;
    const writtenAt = "2026-09-30T12:00:00.000Z";
    try {
      runtimeProvision(first, "r-three");
      unwrap<TurnResult>(await first.say({ residentId: "r-three", text: "前代回合" }));
      const stream = new CanonicalStreamStore({ dataDir: join(dataDir, "streams") });
      const viewport = stream.eventsAfter("r-three", 0)[0]?.origin.viewport;
      if (viewport == null) throw new Error("前代回合没有落下 viewport 身份");
      // 独立输入 fixture 使用现役封缄与信存储，验证已有合法信的消费；不调用草稿生成器。
      const sealed = sealLetter(
        { title: "三档交接信", state: [...state], intent: [...intent] },
        {
          residentId: "r-three",
          windowId: viewport.windowId,
          generation: viewport.generation,
          now: writtenAt,
        },
      );
      new LetterStore(join(dataDir, "letters")).append(sealed);
    } finally {
      // 前代按硬杀结束（没有暂停记录，#234），继任者是下一代。
      await closeLikeHardKill(first, dataDir);
    }
    const recorder = recordingTransport();
    const second = new ResidentRuntime({ dataDir, transport: recorder.transport });
    try {
      const turn = unwrap<TurnResult>(await second.say({ residentId: "r-three", text: "接续" }));
      expect(turn.generation).toBe(2);
      const request = recorder.requests[0];
      if (request === undefined) throw new Error("继任者没有调用 transport");
      expect(request.bootPack.letter).toEqual({
        title: "三档交接信",
        author: "r-three#1",
        writtenAt,
        state: [
          { tier: "commitment", body: "承诺每天写日报" },
          { tier: "fact", body: "上代在做迁移" },
        ],
        intent,
      });
      const prompt = renderSystemPrompt(request);
      for (const item of [...state, ...intent]) {
        expect(prompt).toContain(`- [${item.tier}] ${item.body}`);
      }
    } finally {
      await second.close();
    }
  });

  it("阈值换代后下一次 say 的请求带新一封原信", async () => {
    const recorder = recordingTransport();
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: recorder.transport });
    try {
      runtimeProvision(runtime, "r-th");
      unwrap<void>(
        runtime.setBreathThreshold({
          residentId: "r-th",
          windowId: "w-th",
          generation: 1,
          thresholdTokens: 1,
          authority: "window",
        }),
      );
      // 第一句就到线：回合落账后自动写信换代。
      unwrap<TurnResult>(await runtime.say({ residentId: "r-th", text: "这句到线" }));
      const timeline = unwrap<LetterTimeline>(runtime.letterTimeline({ residentId: "r-th" }));
      expect(timeline.letters).toHaveLength(1);
      const letter = timeline.letters[0];
      expect(letter?.author).toBe("r-th#1");
      const successor = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-th", text: "新一代的话" }),
      );
      expect(successor.generation).toBe(2);
      expect(recorder.requests[1]?.bootPack.letter).toEqual(letter);
      expect(recorder.requests[1]?.history).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("runtime 关闭后重建：重启后的 say 仍消费盘上那封信", async () => {
    const dataDir = tempDir();
    const first = new ResidentRuntime({ dataDir, transport: new SyntheticModelTransport() });
    let breathed: BreatheOutcome;
    try {
      runtimeProvision(first, "r-restart");
      unwrap<TurnResult>(await first.say({ residentId: "r-restart", text: "写封信再走" }));
      breathed = unwrap<BreatheOutcome>(
        await first.breathe({ residentId: "r-restart", via: "new" }),
      );
    } finally {
      await first.close();
    }
    // 同进程中销毁并重建 runtime；新实例从磁盘读信，不宣称独立进程验证。
    const recorder = recordingTransport();
    const second = new ResidentRuntime({ dataDir, transport: recorder.transport });
    try {
      unwrap<TurnResult>(await second.say({ residentId: "r-restart", text: "重启后报到" }));
      expect(recorder.requests[0]?.bootPack.letter).toEqual(breathed.letter);
    } finally {
      await second.close();
    }
  });

  it("没换过代：模型请求与诊断读口的 letter 都是 null", async () => {
    const recorder = recordingTransport();
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: recorder.transport });
    try {
      runtimeProvision(runtime, "r-noletters");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-noletters", text: "第一次开口" }));
      expect(recorder.requests[0]?.bootPack.letter).toBeNull();
      expect(
        unwrap<BootPackView>(runtime.bootPack({ residentId: "r-noletters" })).letter,
      ).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it.each([
    { name: "JSON 不可解析", bytes: "{ broken" },
    {
      name: "条目结构不完整",
      bytes: JSON.stringify({ title: "坏信", residentId: "r-corrupt", generation: 1 }),
    },
  ])("坏信（$name）在调用 transport 之前报 letter-invalid，保留旧流", async ({ bytes }) => {
    const dataDir = tempDir();
    const recorder = recordingTransport();
    const runtime = new ResidentRuntime({ dataDir, transport: recorder.transport });
    try {
      runtimeProvision(runtime, "r-corrupt");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-corrupt", text: "保留的旧流" }));
      const before = unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-corrupt" }));
      unwrap<BreatheOutcome>(await runtime.breathe({ residentId: "r-corrupt", via: "new" }));
      // 把落下的信档写坏。
      writeFileSync(join(dataDir, "letters", "r-corrupt.letter-1.json"), bytes, "utf8");
      const said = await runtime.say({ residentId: "r-corrupt", text: "带着坏信说话" });
      expect(failureOf(said)).toMatchObject({ code: "letter-invalid" });
      // 模型没被调用，也没有伪造回复落进流。
      expect(recorder.requests).toHaveLength(1);
      expect(unwrap<StreamSnapshot>(runtime.readStream({ residentId: "r-corrupt" }))).toEqual(
        before,
      );
      expect(failureOf(runtime.bootPack({ residentId: "r-corrupt" })).code).toBe("letter-invalid");
    } finally {
      await runtime.close();
    }
  });

  it("不同住户不串信：各自的请求只带自己的那封", async () => {
    const recorder = recordingTransport();
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: recorder.transport });
    try {
      runtimeProvision(runtime, "r-one");
      runtimeProvision(runtime, "r-two");
      unwrap<BreatheOutcome>(await runtime.breathe({ residentId: "r-one", via: "new" }));
      unwrap<TurnResult>(await runtime.say({ residentId: "r-one", text: "一户说完" }));
      // r-two 从没换过代：它的请求里不该出现任何信，更不该出现 r-one 的信。
      unwrap<TurnResult>(await runtime.say({ residentId: "r-two", text: "另一户开口" }));
      const one = recorder.requests.find((request) => request.residentId === "r-one");
      const two = recorder.requests.find((request) => request.residentId === "r-two");
      expect(one?.bootPack.letter?.author).toBe("r-one#1");
      expect(two?.bootPack.letter).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("旧代原始聊天不自动塞回历史来掩盖信缺失；currentFacts 与本代正常历史保持", async () => {
    const { ledger, systemWriter } = FactLedger.create();
    ledger.createLedger("r-hy");
    systemWriter.append(
      "r-hy",
      { author: "system", kind: "confirmed_preference", body: "偏好短句" },
      "回归备账：核对 currentFacts 与信同请求在场",
    );
    const recorder = recordingTransport();
    const runtime = new ResidentRuntime({
      dataDir: tempDir(),
      transport: recorder.transport,
      factLedger: ledger,
    });
    try {
      runtimeProvision(runtime, "r-hy");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-hy", text: "旧代的第一句" }));
      // 猝死：旧代流水进归档，但不自动进继任者上下文（D8 三）。
      await runtime.suddenDeath({ residentId: "r-hy" });
      unwrap<TurnResult>(await runtime.say({ residentId: "r-hy", text: "继任者的话" }));
      const successor = recorder.requests[1];
      // 旧代那句不在历史里；继任者自己本代的历史照常。
      expect(successor?.history.map((item) => item.text)).not.toContain("旧代的第一句");
      expect(successor?.bootPack.currentFacts?.map((fact) => fact.body)).toContain("偏好短句");
      expect(successor?.bootPack.letter).toBeNull(); // 猝死没写信：不能凭空冒出一封
      // 本代正常历史保留：再问一句，上一句在历史里。
      unwrap<TurnResult>(await runtime.say({ residentId: "r-hy", text: "再问一句" }));
      const third = recorder.requests[2];
      expect(third?.history.map((item) => item.text)).toContain("继任者的话");
      expect(third?.history.map((item) => item.text)).not.toContain("旧代的第一句");
    } finally {
      await runtime.close();
    }
  });
});

/**
 * #227 第 2 项：usage 观察口 → 真实 runtime 逐回合日志 → 可读表面。抓的是「只 new 一个
 * store / 只声明接口」的漏接线：这里经真实 say() → transport 回调 → usage-log → turnUsage()。
 */
describe("#227 逐回合 usage 日志（真实 runtime 接线 + 读口）", () => {
  /** 录音传输：可选在成功时回调一次 usage，再吐一个非空回复。 */
  function usageTransport(reported: ((call: number) => unknown) | null): {
    transport: ModelTransport;
    calls: () => number;
  } {
    let calls = 0;
    return {
      transport: {
        async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
          calls += 1;
          yield "收到。";
          if (reported !== null) request.onUsage?.(reported(calls) as never);
        },
      },
      calls: () => calls,
    };
  }

  it("上游报 usage：逐回合记录 + 读口逐字段累加，字段原样（含显式 0）", async () => {
    const stub = usageTransport(() => ({
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 5,
      totalTokens: 125,
      costTotal: 0.02,
    }));
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-usage");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-usage", text: "第一句" }));
      unwrap<TurnResult>(await runtime.say({ residentId: "r-usage", text: "第二句" }));
      const view = unwrap(runtime.turnUsage({ residentId: "r-usage" }));
      expect(view.turns).toHaveLength(2);
      expect(view.turns[0]).toMatchObject({
        model: "model-alpha",
        adapterId: "pi-claude-bridge",
        turn: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 5,
          totalTokens: 125,
          costTotal: 0.02,
        },
      });
      expect(view.cumulative).toEqual({
        input: 200,
        output: 40,
        cacheRead: 0,
        cacheWrite: 10,
        totalTokens: 250,
        costTotal: 0.04,
      });
      expect(view.cumulativeCoverage).toEqual({
        totalTurns: 2,
        perField: {
          input: 2,
          output: 2,
          cacheRead: 2,
          cacheWrite: 2,
          totalTokens: 2,
          costTotal: 2,
        },
      });
      expect(view.logError).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("上游没报 usage：回合仍完成，但该回合 turn 缺席（未知，不是零）", async () => {
    const stub = usageTransport(null);
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-nousage");
      const turn = unwrap<TurnResult>(await runtime.say({ residentId: "r-nousage", text: "说话" }));
      expect(turn.reply).toBe("收到。");
      const view = unwrap(runtime.turnUsage({ residentId: "r-nousage" }));
      expect(view.turns).toHaveLength(1);
      expect(view.turns[0]?.turn).toBeUndefined();
      expect(view.cumulative).toEqual({});
      expect(view.cumulativeCoverage.totalTurns).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("部分字段：只累加被报过的字段，coverage 写明每字段覆盖回合数（不冒充完整总量）", async () => {
    const stub = usageTransport((call) => (call === 1 ? { input: 10 } : { output: 4 }));
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-partial");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-partial", text: "一" }));
      unwrap<TurnResult>(await runtime.say({ residentId: "r-partial", text: "二" }));
      const view = unwrap(runtime.turnUsage({ residentId: "r-partial" }));
      expect(view.cumulative).toEqual({ input: 10, output: 4 });
      expect(view.cumulativeCoverage).toEqual({
        totalTurns: 2,
        perField: { input: 1, output: 1 },
      });
    } finally {
      await runtime.close();
    }
  });

  it("住户隔离：一批 usage 只落本户，另一户读不到", async () => {
    const stub = usageTransport(() => ({ input: 7 }));
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-a");
      runtimeProvision(runtime, "r-b");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-a", text: "a 说话" }));
      expect(unwrap(runtime.turnUsage({ residentId: "r-a" })).turns).toHaveLength(1);
      expect(unwrap(runtime.turnUsage({ residentId: "r-b" })).turns).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("字段 allowlist：回调多塞的 raw 字段（prompt/密钥）不进日志", async () => {
    const dataDir = tempDir();
    const stub = usageTransport(
      () =>
        ({
          input: 1,
          prompt: "不该出现的 prompt 正文",
          credentialSecret: "sk-canary-usage",
          raw: { secret: "x" },
        }) as never,
    );
    const runtime = new ResidentRuntime({ dataDir, transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-allow");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-allow", text: "说话" }));
      const view = unwrap(runtime.turnUsage({ residentId: "r-allow" }));
      expect(view.turns[0]?.turn).toEqual({ input: 1 });
      const raw = readFileSync(join(dataDir, "logs", "r-allow.usage.jsonl"), "utf8");
      expect(raw).not.toContain("不该出现的 prompt 正文");
      expect(raw).not.toContain("sk-canary-usage");
      expect(raw).not.toContain("credentialSecret");
    } finally {
      await runtime.close();
    }
  });

  it("密钥扫描：usage 日志面不含 canary 密钥（RT-06 扫描面之一）", async () => {
    const stub = usageTransport(() => ({ input: 3, output: 1 }));
    const runtime = new ResidentRuntime({ dataDir: tempDir(), transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-scan", "sk-canary-scan-usage");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-scan", text: "说话" }));
      const report = unwrap(
        runtime.secretScan({ residentId: "r-scan", needle: "sk-canary-scan-usage" }),
      );
      expect(report.hits).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("写日志失败不改变回合完成语义：回合仍 ok，读口如实拒绝不可读日志", async () => {
    const dataDir = tempDir();
    const stub = usageTransport(() => ({ input: 2 }));
    const runtime = new ResidentRuntime({ dataDir, transport: stub.transport });
    try {
      runtimeProvision(runtime, "r-logfail");
      // 把 logs/<id>.usage.jsonl 变成目录，让 append 必然失败。
      mkdirSync(join(dataDir, "logs", "r-logfail.usage.jsonl"), { recursive: true });
      const turn = unwrap<TurnResult>(await runtime.say({ residentId: "r-logfail", text: "说话" }));
      expect(turn.reply).toBe("收到。");
      expect(runtime.turnUsage({ residentId: "r-logfail" })).toMatchObject({
        ok: false,
        error: { code: "writer-unavailable" },
      });
      // 一窗流照常落账（回合完整），不因为日志失败而回滚。
      expect(unwrap(runtime.readStream({ residentId: "r-logfail" })).events).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it("usage read gate refuses unaccepted candidates and path-shaped identifiers", async () => {
    const runtime = new ResidentRuntime({
      dataDir: tempDir(),
      transport: usageTransport(null).transport,
    });
    try {
      const pending = runtime.createCandidate({
        residentId: "r-usage-pending",
        persona: "synthetic",
        proposedBy: { kind: "installer", id: "test" },
      });
      expect(runtime.turnUsage({ residentId: pending.candidateId })).toMatchObject({
        ok: false,
        error: { code: "resident-not-found" },
      });
      expect(runtime.turnUsage({ residentId: "../../outside" })).toMatchObject({
        ok: false,
        error: { code: "resident-not-found" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("usage only accepts canonical residentId after activation", async () => {
    const runtime = new ResidentRuntime({ dataDir: tempDir() });
    try {
      const candidate = runtime.createCandidate({
        residentId: "review-usage",
        persona: "synthetic",
        proposedBy: { kind: "installer", id: "test" },
      });
      runtime.attestCandidate(
        candidate.candidateId,
        { kind: "candidate", candidateId: candidate.candidateId },
        "accepted",
      );
      expect(runtime.turnUsage({ residentId: "review-usage" })).toMatchObject({ ok: true });
      expect(runtime.turnUsage({ residentId: candidate.candidateId })).toMatchObject({
        ok: false,
        error: { code: "resident-not-found" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("usage preserves valid records on both sides of a truncated line and counts damaged records", async () => {
    const dataDir = tempDir();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: usageTransport(() => ({ input: 2 })).transport,
    });
    try {
      runtimeProvision(runtime, "review-truncated");
      unwrap(await runtime.say({ residentId: "review-truncated", text: "first" }));
      const path = join(dataDir, "logs", "review-truncated.usage.jsonl");
      const before = readFileSync(path, "utf8");
      writeFileSync(path, `${before}{ truncated`);
      unwrap(await runtime.say({ residentId: "review-truncated", text: "second" }));
      const view = unwrap(runtime.turnUsage({ residentId: "review-truncated" }));
      expect(view.turns).toHaveLength(2);
      expect(view.cumulative).toMatchObject({ input: 4 });
      expect(view).toMatchObject({ invalidRecords: 1, cumulativeCoverage: { totalTurns: 2 } });
      expect(readFileSync(path, "utf8")).toContain("{ truncated\n{");
    } finally {
      await runtime.close();
    }
  });

  it("a usage symlink cannot change another file or the successful chat result", async () => {
    const dataDir = tempDir();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: usageTransport(() => ({ input: 2 })).transport,
    });
    try {
      runtimeProvision(runtime, "r-log-link");
      const other = join(dataDir, "other.json");
      const original = '{"private":"synthetic-log-link-canary"}';
      writeFileSync(other, original);
      symlinkSync(other, join(dataDir, "logs", "r-log-link.usage.jsonl"));
      expect((await runtime.say({ residentId: "r-log-link", text: "hello" })).ok).toBe(true);
      expect(readFileSync(other, "utf8")).toBe(original);
      const read = runtime.turnUsage({ residentId: "r-log-link" });
      expect(read.ok).toBe(false);
      expect(JSON.stringify(read)).not.toContain("synthetic-log-link-canary");
    } finally {
      await runtime.close();
    }
  });

  it("a usage hard link cannot change another file or its permissions", async () => {
    const dataDir = tempDir();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: usageTransport(() => ({ input: 2 })).transport,
    });
    try {
      runtimeProvision(runtime, "r-log-hardlink");
      const other = join(dataDir, "other.json");
      const original = '{"private":"synthetic-hardlink-canary"}';
      writeFileSync(other, original, { mode: 0o640 });
      const mode = statSync(other).mode;
      linkSync(other, join(dataDir, "logs", "r-log-hardlink.usage.jsonl"));
      expect((await runtime.say({ residentId: "r-log-hardlink", text: "hello" })).ok).toBe(true);
      expect(readFileSync(other, "utf8")).toBe(original);
      expect(statSync(other).mode).toBe(mode);
      expect(runtime.turnUsage({ residentId: "r-log-hardlink" }).ok).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(process.platform === "win32")("a FIFO usage target fails without blocking", () => {
    const dataDir = tempDir();
    const target = join(dataDir, "r-fifo.usage.jsonl");
    const fifo = spawnSync("mkfifo", [target], { encoding: "utf8" });
    expect(fifo.status).toBe(0);
    const module = fileURLToPath(new URL("../src/resident-runtime/usage-log.ts", import.meta.url));
    // 放独立子进程并设超时：错误实现同步 open FIFO 时也能被测试拒绝，不挂死 Vitest。
    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { TurnUsageLog } from ${JSON.stringify(module)};
const log = new TurnUsageLog(${JSON.stringify(dataDir)});
const result = log.record("r-fifo", { turnId: "t", generation: 0, model: "synthetic", adapterId: "synthetic", at: "synthetic" });
let readFailed = false;
try { log.read("r-fifo"); } catch { readFailed = true; }
console.log(JSON.stringify({ result, readFailed }));`,
      ],
      { encoding: "utf8", timeout: 3_000 },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout)).toMatchObject({ result: { ok: false }, readFailed: true });
  });
});

describe("正常退出接回同一代（#234 主笔裁定 A）", () => {
  /** 与终端、宿主子进程同一套装配：接认证权威事实账（assembly.ts 的口径）。 */
  function pausable(
    dataDir: string,
    transport: ModelTransport = new SyntheticModelTransport(),
  ): ResidentRuntime {
    return new ResidentRuntime({
      dataDir,
      transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
  }

  function recorder(): { transport: ModelTransport; requests: ModelCompletionRequest[] } {
    const requests: ModelCompletionRequest[] = [];
    const upstream = new SyntheticModelTransport();
    return {
      transport: {
        async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
          requests.push(request);
          yield* upstream.complete(request);
        },
      },
      requests,
    };
  }

  /** 暂停记录的约定落点：`<dataDir>/sessions/paused/<residentId>.json`。 */
  const pausePath = (dataDir: string, residentId: string): string =>
    join(dataDir, "sessions", "paused", `${residentId}.json`);
  const journalOf = (dataDir: string): string =>
    readFileSync(join(dataDir, "sessions", "windows.journal"), "utf8");

  async function pausedAfterOneTurn(residentId: string, dataDir = tempDir()) {
    const first = pausable(dataDir);
    runtimeProvision(first, residentId);
    const turn = unwrap<TurnResult>(await first.say({ residentId, text: "暂停前那句" }));
    const stream = unwrap<StreamSnapshot>(first.readStream({ residentId }));
    await first.close();
    return { dataDir, turn, stream };
  }

  it("正常退出给活窗落暂停记录：0600、只带这次激活的身份与时刻", async () => {
    const { dataDir, turn } = await pausedAfterOneTurn("r-pause");
    const path = pausePath(dataDir, "r-pause");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const viewport = new CanonicalStreamStore({ dataDir: join(dataDir, "streams") }).eventsAfter(
      "r-pause",
      0,
    )[0]?.origin.viewport;
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schemaVersion: 1,
      residentId: "r-pause",
      windowId: viewport?.windowId,
      scopeId: "private",
      scopeGeneration: 1,
      generation: turn.generation,
      pausedAt: expect.any(String),
    });
  });

  it("再启动接回同一窗同一代：上一段随请求进模型、流只追加、记录用掉即作废、窗账不长", async () => {
    const { dataDir, turn, stream } = await pausedAfterOneTurn("r-resume");
    const journal = journalOf(dataDir);
    const rec = recorder();
    const second = pausable(dataDir, rec.transport);
    try {
      const next = unwrap<TurnResult>(await second.say({ residentId: "r-resume", text: "接着说" }));
      expect(next.generation).toBe(turn.generation);
      expect(rec.requests[0]?.history).toEqual([
        { role: "user", text: "暂停前那句" },
        { role: "assistant", text: turn.reply },
      ]);
      const after = unwrap<StreamSnapshot>(second.readStream({ residentId: "r-resume" }));
      expect(after.events).toHaveLength(4);
      expect(after.events.slice(0, 2)).toEqual(stream.events);
      expect(new Set(after.events.map((event) => event.streamSeq)).size).toBe(4);
      expect(existsSync(pausePath(dataDir, "r-resume"))).toBe(false);
      expect(journalOf(dataDir)).toBe(journal);
    } finally {
      await second.close();
    }
  });

  it.each([
    ["缺失", (_raw: string): string | null => null],
    ["截断损坏", (raw: string): string | null => raw.slice(0, Math.floor(raw.length / 2))],
    ["指向别的窗", (raw: string) => JSON.stringify({ ...JSON.parse(raw), windowId: "w_other" })],
    ["代际对不上", (raw: string) => JSON.stringify({ ...JSON.parse(raw), generation: 2 })],
    [
      "scope 代际对不上",
      (raw: string) => JSON.stringify({ ...JSON.parse(raw), scopeGeneration: 2 }),
    ],
    ["别的住户", (raw: string) => JSON.stringify({ ...JSON.parse(raw), residentId: "r-other" })],
    ["多带字段", (raw: string) => JSON.stringify({ ...JSON.parse(raw), note: "x" })],
  ])("暂停记录%s：一律按猝死开新一代，记录不留", async (_label, tamper) => {
    const { dataDir, turn } = await pausedAfterOneTurn("r-tampered");
    const path = pausePath(dataDir, "r-tampered");
    const replaced = tamper(readFileSync(path, "utf8"));
    if (replaced === null) rmSync(path);
    else writeFileSync(path, replaced);
    const rec = recorder();
    const second = pausable(dataDir, rec.transport);
    try {
      const next = unwrap<TurnResult>(await second.say({ residentId: "r-tampered", text: "醒来" }));
      expect(next.generation).toBe(turn.generation + 1);
      expect(rec.requests[0]?.history).toEqual([]);
      expect(existsSync(path)).toBe(false);
    } finally {
      await second.close();
    }
  });

  it("初始快照还没交付就退出：不落暂停记录，下次启动按新一代重新对齐", async () => {
    const dataDir = tempDir();
    let upstreamDown = true;
    const flaky: ModelTransport = {
      async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
        if (upstreamDown) throw new Error("上游断了");
        yield* new SyntheticModelTransport().complete(request);
      },
    };
    const first = pausable(dataDir, flaky);
    runtimeProvision(first, "r-pending");
    first
      .ledgerAuthority()
      ?.host.system("runtime-test")
      .append("r-pending", { kind: "active_rule", body: "开窗前的事实" }, "回归夹具");
    // 窗开了、账登记了，但这一回合没交付：初始快照还挂在内存里。
    expect(failureOf(await first.say({ residentId: "r-pending", text: "没说成" })).code).toBe(
      "channel-unavailable",
    );
    await first.close();
    expect(existsSync(pausePath(dataDir, "r-pending"))).toBe(false);

    upstreamDown = false;
    const rec = recorder();
    const second = pausable(dataDir, rec.transport);
    try {
      const next = unwrap<TurnResult>(await second.say({ residentId: "r-pending", text: "再说" }));
      expect(next.generation).toBe(2);
      expect(rec.requests[0]?.bootPack.currentFacts?.map((fact) => fact.body)).toEqual([
        "开窗前的事实",
      ]);
    } finally {
      await second.close();
    }
  });

  it("一位住户的暂停记录写不成：close 照样写完别的住户、关掉 writer，这位下次按猝死开新一代", async () => {
    const dataDir = tempDir();
    const first = pausable(dataDir);
    for (const residentId of ["r-unwritable", "r-written"]) {
      runtimeProvision(first, residentId);
      unwrap<TurnResult>(await first.say({ residentId, text: "暂停前那句" }));
    }
    // 目标位置被一个目录占住：这位住户的原子 rename 必然失败。
    mkdirSync(join(pausePath(dataDir, "r-unwritable"), "occupied"), { recursive: true });
    const closing = vi.spyOn(CanonicalStreamWriter.prototype, "close");
    await expect(first.close()).resolves.toBeUndefined();
    expect(closing).toHaveBeenCalledTimes(1);
    expect(failureOf(await first.say({ residentId: "r-written", text: "关了还说" })).code).toBe(
      "writer-unavailable",
    );
    expect(statSync(pausePath(dataDir, "r-unwritable")).isDirectory()).toBe(true);
    expect(statSync(pausePath(dataDir, "r-written")).isFile()).toBe(true);

    const second = pausable(dataDir);
    try {
      const forgotten = unwrap<TurnResult>(
        await second.say({ residentId: "r-unwritable", text: "醒来" }),
      );
      expect(forgotten.generation).toBe(2);
      const resumed = unwrap<TurnResult>(
        await second.say({ residentId: "r-written", text: "接着" }),
      );
      expect(resumed.generation).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("registry 认、认证账不认这一代：先归档接回的窗，再按猝死开新一代并重新对齐", async () => {
    const { dataDir, turn } = await pausedAfterOneTurn("r-ledger-refuses");
    // 账上那行确认位的身份改成别的一代：形状合法、能恢复，但对不上暂停记录。
    const factsPath = join(dataDir, "residents", "r-ledger-refuses.facts.json");
    const facts = JSON.parse(readFileSync(factsPath, "utf8")) as {
      viewports: { identity: { generation: number } | null }[];
    };
    const row = facts.viewports[0];
    if (row?.identity == null) throw new Error("夹具：认证账没有落下确认位身份");
    row.identity.generation = turn.generation + 5;
    writeFileSync(factsPath, JSON.stringify(facts));
    const journal = journalOf(dataDir);
    const rec = recorder();
    const second = pausable(dataDir, rec.transport);
    try {
      const next = unwrap<TurnResult>(
        await second.say({ residentId: "r-ledger-refuses", text: "醒来" }),
      );
      expect(next.generation).toBe(turn.generation + 1);
      expect(rec.requests[0]?.history).toEqual([]);
      expect(existsSync(pausePath(dataDir, "r-ledger-refuses"))).toBe(false);
      const appended = journalOf(dataDir)
        .slice(journal.length)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; window: { generation: number } });
      expect(appended.map((event) => [event.type, event.window.generation])).toEqual([
        ["window_archived", turn.generation],
        ["window_opened", turn.generation + 1],
      ]);
    } finally {
      await second.close();
    }
  });

  /** 住户宿主锁的约定落点：`<dataDir>/sessions/active/<residentId>.lock`。 */
  const lockPath = (dataDir: string, residentId: string): string =>
    join(dataDir, "sessions", "active", `${residentId}.lock`);

  /** 一位住户在盘上留下的可变状态：流、窗账、换气配置、信与暂停记录，逐字快照。 */
  function diskState(dataDir: string, residentId: string): Record<string, string | null> {
    const read = (path: string): string | null =>
      existsSync(path) ? readFileSync(path, "utf8") : null;
    const letters = join(dataDir, "letters");
    return {
      stream: read(join(dataDir, "streams", `${residentId}.stream.json`)),
      journal: read(join(dataDir, "sessions", "windows.journal")),
      breath: read(join(dataDir, "sessions", "breath.json")),
      paused: read(pausePath(dataDir, residentId)),
      letters: existsSync(letters) ? readdirSync(letters).sort().join(",") : null,
    };
  }

  it("开窗时拿住户宿主锁（0600、本进程 pid），close 放掉；关了以后说话、换气、改线都在调模型与写盘之前拒绝", async () => {
    const dataDir = tempDir();
    const rec = recorder();
    const runtime = pausable(dataDir, rec.transport);
    runtimeProvision(runtime, "r-locked");
    const path = lockPath(dataDir, "r-locked");
    expect(existsSync(path)).toBe(false);
    const opened = unwrap<TurnResult>(await runtime.say({ residentId: "r-locked", text: "开窗" }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schemaVersion: 1,
      residentId: "r-locked",
      pid: process.pid,
      token: expect.any(String),
      startedAt: expect.any(String),
    });
    await runtime.close();
    expect(existsSync(path)).toBe(false);
    const before = diskState(dataDir, "r-locked");
    const said = await runtime.say({ residentId: "r-locked", text: "关了还说" });
    expect(failureOf(said).code).toBe("writer-unavailable");
    if (said.ok) throw new Error("unreachable");
    expect(said.error.message).toContain("已关闭");
    expect(failureOf(await runtime.breathe({ residentId: "r-locked", via: "new" })).code).toBe(
      "writer-unavailable",
    );
    for (const authority of ["window", "owner"] as const) {
      const threshold = runtime.setBreathThreshold({
        residentId: "r-locked",
        windowId: "w-locked",
        generation: opened.generation,
        thresholdTokens: 10,
        authority,
      });
      expect(failureOf(threshold).code).toBe("writer-unavailable");
    }
    expect(rec.requests).toHaveLength(1);
    expect(diskState(dataDir, "r-locked")).toEqual(before);
    await runtime.close();
    expect(existsSync(path)).toBe(false);
  });

  it("本进程拿着的锁被接管或删掉：下一回合开头就停下，说话、换气、改线都不调模型、不写盘，也不自己重建锁", async () => {
    const dataDir = tempDir();
    const rec = recorder();
    const runtime = pausable(dataDir, rec.transport);
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      runtimeProvision(runtime, "r-displaced");
      const opened = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-displaced", text: "开窗" }),
      );
      const path = lockPath(dataDir, "r-displaced");
      const displacer = JSON.stringify({
        schemaVersion: 1,
        residentId: "r-displaced",
        pid: holder.pid,
        token: "displacer",
        startedAt: "2026-10-17T00:00:00.000Z",
      });
      for (const displace of [
        () => writeFileSync(path, displacer),
        () => rmSync(path, { force: true }),
      ]) {
        displace();
        const before = diskState(dataDir, "r-displaced");
        const lockBefore = existsSync(path) ? readFileSync(path, "utf8") : null;
        const said = await runtime.say({ residentId: "r-displaced", text: "还在吗" });
        if (said.ok) throw new Error("锁被挤掉后竟然说成了");
        expect(said.error.code).toBe("writer-unavailable");
        expect(said.error.message).toContain("已被接管或删除");
        expect(said.error.remedy).toContain(path);
        expect(
          failureOf(await runtime.breathe({ residentId: "r-displaced", via: "new" })).code,
        ).toBe("writer-unavailable");
        const threshold = runtime.setBreathThreshold({
          residentId: "r-displaced",
          windowId: "w-displaced",
          generation: opened.generation,
          thresholdTokens: 10,
          authority: "owner",
        });
        expect(failureOf(threshold).code).toBe("writer-unavailable");
        expect(rec.requests).toHaveLength(1);
        expect(diskState(dataDir, "r-displaced")).toEqual(before);
        expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(lockBefore);
      }
    } finally {
      holder.kill("SIGKILL");
      await runtime.close();
    }
  });

  it("另一个活进程拿着锁：说话、换气、改线都在调模型与写流之前拒成 writer-unavailable，暂停记录不碰；那个进程没了再起就接回同一代", async () => {
    const { dataDir, turn, stream } = await pausedAfterOneTurn("r-busy");
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const holderGone = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    try {
      const path = lockPath(dataDir, "r-busy");
      mkdirSync(join(dataDir, "sessions", "active"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r-busy",
          pid: holder.pid,
          token: "elsewhere",
          startedAt: "2026-10-17T00:00:00.000Z",
        }),
      );
      const record = readFileSync(pausePath(dataDir, "r-busy"), "utf8");
      const journal = journalOf(dataDir);
      const rec = recorder();
      const second = pausable(dataDir, rec.transport);
      try {
        const refused = await second.say({ residentId: "r-busy", text: "抢着说" });
        if (refused.ok) throw new Error("锁在别的活进程手里竟然说成了");
        expect(refused.error.code).toBe("writer-unavailable");
        expect(refused.error.message).toContain(`pid ${String(holder.pid)}`);
        expect(refused.error.remedy).toContain(path);
        expect(failureOf(await second.breathe({ residentId: "r-busy", via: "new" })).code).toBe(
          "writer-unavailable",
        );
        const threshold = second.setBreathThreshold({
          residentId: "r-busy",
          windowId: "w-busy",
          generation: turn.generation,
          thresholdTokens: 10,
          authority: "owner",
        });
        expect(failureOf(threshold).code).toBe("writer-unavailable");
        expect(rec.requests).toHaveLength(0);
        expect(unwrap<StreamSnapshot>(second.readStream({ residentId: "r-busy" })).events).toEqual(
          stream.events,
        );
        expect(readFileSync(pausePath(dataDir, "r-busy"), "utf8")).toBe(record);
        expect(journalOf(dataDir)).toBe(journal);
      } finally {
        await second.close();
      }
      // 没拿到的锁，close 不放。
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe("elsewhere");

      holder.kill("SIGKILL");
      await holderGone;
      const after = recorder();
      const third = pausable(dataDir, after.transport);
      try {
        const next = unwrap<TurnResult>(await third.say({ residentId: "r-busy", text: "轮到我" }));
        expect(next.generation).toBe(turn.generation);
        expect(after.requests[0]?.history).toEqual([
          { role: "user", text: "暂停前那句" },
          { role: "assistant", text: turn.reply },
        ]);
        expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
      } finally {
        await third.close();
      }
      expect(existsSync(path)).toBe(false);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });

  it("坏掉的锁当陈锁接管：照常开窗说话", async () => {
    const dataDir = tempDir();
    const runtime = pausable(dataDir);
    runtimeProvision(runtime, "r-garbled-lock");
    const path = lockPath(dataDir, "r-garbled-lock");
    mkdirSync(join(dataDir, "sessions", "active"), { recursive: true });
    writeFileSync(path, '{"pid": 1, "tok');
    try {
      unwrap<TurnResult>(await runtime.say({ residentId: "r-garbled-lock", text: "照常" }));
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    } finally {
      await runtime.close();
    }
    expect(existsSync(path)).toBe(false);
  });

  it("被挤掉的持有者 close()：不落暂停记录，继任者的暂停记录逐字不动；锁还在手的住户照常落", async () => {
    const dataDir = tempDir();
    const displaced = pausable(dataDir);
    for (const residentId of ["r-superseded", "r-still-mine"]) {
      runtimeProvision(displaced, residentId);
      unwrap<TurnResult>(await displaced.say({ residentId, text: "暂停前那句" }));
    }
    // 继任者接管了 r-superseded、跑到下一代、正常退出：落下自己的暂停记录，放掉锁。
    const successorRecord = `${JSON.stringify({
      schemaVersion: 1,
      residentId: "r-superseded",
      windowId: "w_successor",
      scopeId: "private",
      scopeGeneration: 1,
      generation: 2,
      pausedAt: "2026-10-18T00:00:00.000Z",
    })}\n`;
    mkdirSync(join(dataDir, "sessions", "paused"), { recursive: true });
    writeFileSync(pausePath(dataDir, "r-superseded"), successorRecord);
    rmSync(lockPath(dataDir, "r-superseded"));
    await displaced.close();
    expect(readFileSync(pausePath(dataDir, "r-superseded"), "utf8")).toBe(successorRecord);
    expect(JSON.parse(readFileSync(pausePath(dataDir, "r-still-mine"), "utf8"))).toMatchObject({
      residentId: "r-still-mine",
      generation: 1,
    });
  });

  it("被挤掉的持有者 suddenDeath：拒绝且什么都不写，继任者开出下一代后的 journal 照样回放得了", async () => {
    const dataDir = tempDir();
    const displaced = pausable(dataDir);
    const successorProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      runtimeProvision(displaced, "r-sudden");
      unwrap<TurnResult>(await displaced.say({ residentId: "r-sudden", text: "第一代" }));
      // 继任者接管锁，按同一窗号开出第 2 代（它那边的 registry 往同一份 journal 追加）。
      writeFileSync(
        lockPath(dataDir, "r-sudden"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r-sudden",
          pid: successorProcess.pid,
          token: "successor",
          startedAt: "2026-10-18T00:00:00.000Z",
        }),
      );
      const archivePath = join(dataDir, "sessions", "windows.journal");
      const index = JSON.parse(
        readFileSync(join(dataDir, "sessions", "window-index.json"), "utf8"),
      ) as { windows: Record<string, string> };
      const successor = new SessionRegistry<{ letter: null }>({ archivePath });
      expect(
        successor.open("r-sudden", {
          context: { letter: null },
          windowId: index.windows["r-sudden"] ?? "",
        }).generation,
      ).toBe(2);
      const before = diskState(dataDir, "r-sudden");
      await expect(displaced.suddenDeath({ residentId: "r-sudden" })).rejects.toThrow(
        /已被接管或删除/,
      );
      expect(diskState(dataDir, "r-sudden")).toEqual(before);
      expect(() => new SessionRegistry({ archivePath })).not.toThrow();
    } finally {
      successorProcess.kill("SIGKILL");
      await displaced.close();
    }
  });

  it("接回的这一代暂停前已起过回合：窗照旧无权给自己改线（D8 一）", async () => {
    const { dataDir, turn } = await pausedAfterOneTurn("r-lock");
    const second = pausable(dataDir);
    try {
      const refused = second.setBreathThreshold({
        residentId: "r-lock",
        windowId: "w-lock",
        generation: turn.generation,
        thresholdTokens: 10,
        authority: "window",
      });
      if (refused.ok) throw new Error("接回后窗给自己改线竟然成功了");
      expect(refused.error.code).toBe("breath-refused");
      expect(refused.error.message).toContain("回合已起");
    } finally {
      await second.close();
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

/**
 * 进程内的「硬杀」：同一进程里旧 runtime 不 close 就开不出第二个 writer（WriterOwnershipError），
 * 所以先 close 再删掉暂停记录——close() 落盘的只有暂停记录（#234），删掉后盘面与没走到
 * close 的进程留下的一样。真进程 SIGKILL 见 resident-runtime-host-boundary.test.ts 与 RT-09。
 */
async function closeLikeHardKill(runtime: ResidentRuntime, dataDir: string): Promise<void> {
  await runtime.close();
  rmSync(join(dataDir, "sessions", "paused"), { recursive: true, force: true });
}

function activateResident(runtime: ResidentRuntime, residentId: string): void {
  const candidate = runtime.createCandidate({
    persona: `persona:${residentId}`,
    proposedBy: { kind: "installer", id: "runtime-test" },
    residentId,
  });
  const activated = runtime.attestCandidate(
    candidate.candidateId,
    { kind: "candidate", candidateId: candidate.candidateId },
    "accepted",
  );
  if (!activated.ok || activated.value.residentId !== residentId) {
    throw new Error(`failed to activate test resident ${residentId}`);
  }
}

function runtimeProvision(
  runtime: ResidentRuntime,
  residentId: string,
  canarySecret = `sk-${residentId}`,
): ReturnType<ResidentRuntime["provisionChannel"]> {
  if (!runtime.requireActiveResident(residentId).ok) activateResident(runtime, residentId);
  return runtime.provisionChannel({
    residentId,
    channel: claudeChannel,
    canarySecret,
  });
}
