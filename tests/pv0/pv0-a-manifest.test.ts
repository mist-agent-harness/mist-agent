/**
 * PV0 acceptance suite — series A: Manifest 与兼容性 (RFC §2)
 *
 * Doctrine (#76, 旦九 2026-08-20 ruling): PV0 runs as an independent Vitest suite,
 * NOT inside the six-lights acceptance driver. Every unimplemented item stays an
 * honest `it.todo` — fixture-backed stubs must be declared STUBBED in the PR body,
 * and nothing here is allowed to impersonate green.
 *
 * Item source of truth: acceptance/plugin-protocol-v0.md at the #62 freeze point
 * (main@acdfcab2); titles copied verbatim.
 *
 * A01–A04/A06–A10 run REAL：真实包目录 fixture、顶层抛错的探针 entrypoint、零 import
 * 取证；A07 与 A10 经 applyEnabledChange 生产入口交付（A07 含 blocked 停用与崩溃窗
 * 回归；A10 为半绿——context 交付/快照扫描真绿，日志/事件 sink 未建+同进程隔离不可证
 * 按阻塞申报，见 PR 正文）。A08 的写盘门半场取证于 pv0-a08-write-gate.test.ts。
 * A05 仍为 honest todo——等 readiness scope 投影面。
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MANIFEST_FILENAME,
  capabilityDirectory,
  checkInstanceConfig,
  discoverPlugin,
} from "../../src/plugin/discovery.ts";
import { applyEnabledChange } from "../../src/plugin/enable.ts";
import { resolveEnvironment } from "../../src/plugin/environment.ts";
import type { LifecycleState } from "../../src/plugin/lifecycle.ts";
import type { PluginInstanceConfig, PluginManifestV0 } from "../../src/plugin/manifest.ts";
import { moduleRefFromSource } from "../../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../../src/plugin/operation-store.ts";
import { PluginTransactionHost } from "../../src/plugin/transaction-host.ts";
import type { PluginModuleV0, PreparedPlugin } from "../../src/plugin/types.ts";

const HOST = { hostVersion: "0.4.0", activeIds: new Set<string>() } as const;

/** 探针全局名：entrypoint 一旦被 import 就会置位并抛错；各条断言它始终未置位。 */
const PROBE = "__PV0_A06_PROBE__";
const PROBE_ENTRY = `globalThis["${PROBE}"] = (globalThis["${PROBE}"] ?? 0) + 1;\nthrow new Error("PV0-A06 probe: plugin code must never load during manifest validation");\n`;

let root: string;
let seq = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pv0-a-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function pkg(manifest: unknown): Promise<string> {
  const dir = join(root, `pkg-${seq++}`);
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "index.js"), PROBE_ENTRY);
  if (manifest !== undefined) {
    const body = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
    await writeFile(join(dir, MANIFEST_FILENAME), body);
  }
  return dir;
}

function manifestOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestSchemaVersion: 0,
    id: "demo.plugin",
    version: "1.0.0",
    requiresMist: ">=0.1.0",
    entrypoint: "dist/index.js",
    kinds: ["tool_capability"],
    configSchemaVersion: 1,
    capabilities: [
      {
        id: "cap.echo",
        description: "echo",
        effect: "read",
        operations: ["echo"],
        injectionMode: "eager",
      },
    ],
    contextInjections: [],
    env: [],
    credentials: [],
    permissions: [],
    ...overrides,
  };
}

function probeCount(): number {
  const v = (globalThis as Record<string, unknown>)[PROBE];
  return typeof v === "number" ? v : 0;
}

describe("PV0 series A — Manifest 与兼容性 (RFC §2)", () => {
  it("[PV0-A01] 合法 manifest 可进入 prepare", async () => {
    const records = new Map<string, { state: LifecycleState; manifest: PluginManifestV0 }>();
    for (const kind of ["channel_adapter", "frontend", "tool_capability", "bridge"]) {
      const dir = await pkg(manifestOf({ id: `demo.${kind.replace(/_/g, "-")}`, kinds: [kind] }));
      const r = await discoverPlugin(dir, HOST);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.state).toBe("validated");
        records.set(r.manifest.id, { state: r.state, manifest: r.manifest });
      }
    }
    // 校验后尚未出现在能力目录：目录只枚举 active，validated 恒缺席。
    expect(capabilityDirectory(records)).toEqual([]);
    expect(probeCount()).toBe(0);
  });

  it("[PV0-A02] 未知 schema fail-closed", async () => {
    const r = await discoverPlugin(await pkg(manifestOf({ manifestSchemaVersion: 99 })), HOST);
    expect(r).toMatchObject({ ok: false, state: "blocked", reasonCode: "HOST_INCOMPATIBLE" });
    expect(probeCount()).toBe(0); // 插件代码未加载、无资源注册
  });

  it("[PV0-A03] requiresMist 不可猜", async () => {
    const unmatched = await discoverPlugin(
      await pkg(manifestOf({ requiresMist: ">=9.0.0" })),
      HOST,
    );
    expect(unmatched).toMatchObject({ ok: false, reasonCode: "HOST_INCOMPATIBLE" });
    const unparseable = await discoverPlugin(
      await pkg(manifestOf({ requiresMist: "one point oh" })),
      HOST,
    );
    expect(unparseable).toMatchObject({ ok: false, reasonCode: "HOST_INCOMPATIBLE" });
    expect(probeCount()).toBe(0); // 两者均在加载代码前返回
  });

  it("[PV0-A04] 路径与枚举封口", async () => {
    const badShapes: readonly Record<string, unknown>[] = [
      { entrypoint: "../outside.js" },
      { contextInjections: [{ id: "g", source: "../creed.md", scope: "resident" }] },
      { kinds: ["gadget"] },
      {
        capabilities: [
          { id: "c", description: "", effect: "chaotic", operations: [], injectionMode: "eager" },
        ],
      },
      {
        capabilities: [
          { id: "c", description: "", effect: "read", operations: [], injectionMode: "someday" },
        ],
      },
      {
        capabilities: [
          { id: "c", description: "", effect: "read", operations: [], injectionMode: "eager" },
          { id: "c", description: "", effect: "read", operations: [], injectionMode: "lazy" },
        ],
      },
      {
        contextInjections: [
          { id: "g", source: "a.md", scope: "resident" },
          { id: "g", source: "b.md", scope: "session" },
        ],
      },
    ];
    for (const bad of badShapes) {
      const r = await discoverPlugin(await pkg(manifestOf(bad)), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
    // 153/19F 反例一：词法干净但 symlink 逃根 —— 物理封口回归（entrypoint + source 两路）
    const { symlink, mkdir: mkdirP, writeFile: writeF } = await import("node:fs/promises");
    const outside = join(root, `outside-${seq++}`);
    await mkdirP(outside, { recursive: true });
    await writeF(join(outside, "index.js"), PROBE_ENTRY);
    await writeF(join(outside, "creed.md"), "escaped");
    const linkedPkg = await pkg(manifestOf({ entrypoint: "linked/index.js" }));
    await symlink(outside, join(linkedPkg, "linked"), "dir");
    const viaEntrySymlink = await discoverPlugin(linkedPkg, HOST);
    expect(viaEntrySymlink).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const linkedSrcPkg = await pkg(
      manifestOf({
        contextInjections: [{ id: "g", source: "linked/creed.md", scope: "resident" }],
      }),
    );
    await symlink(outside, join(linkedSrcPkg, "linked"), "dir");
    const viaSourceSymlink = await discoverPlugin(linkedSrcPkg, HOST);
    expect(viaSourceSymlink).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    expect(probeCount()).toBe(0); // 且无部分注册：本层不存在注册通道
  });

  it.todo(
    "[PV0-A05] 缺要求不降级装 — REQUIREMENT_MISSING 判据已在 tests/plugin-manifest.test.ts 常驻；本题还要求 optional 缺失时 readiness 明列缺失 scope，readiness 投影未实现前不计绿（153/19F 裁定）",
  );

  it("[PV0-A06] manifest 无需执行代码", async () => {
    // 探针 entrypoint 顶层即抛错；非法 manifest 校验后探针计数为零 = import 从未发生。
    const broken = await discoverPlugin(await pkg('{"not": "valid manifest"'), HOST);
    expect(broken).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const missing = await discoverPlugin(await pkg(undefined), HOST);
    expect(missing).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    expect(probeCount()).toBe(0);
  });

  it("[PV0-A07] 停用是真卸载", async () => {
    const store = new PluginOperationStore(join(root, `store-a07-${seq++}`));
    const host = new PluginTransactionHost({ store, newOperationId: () => `op-${seq++}` });
    const discovered = await discoverPlugin(await pkg(manifestOf({ id: "demo.toggle" })), HOST);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    const calls: string[] = [];
    const module = {
      async prepare(context: import("../../src/plugin/types.ts").PluginPrepareContext) {
        calls.push("prepare");
        context.register({
          id: "res-1",
          kind: "tool" as const,
          recoveryKey: "rk-1",
          async activate() {
            calls.push("resource.activate");
          },
          async dispose() {
            calls.push("resource.dispose");
          },
        });
        return {
          async activate() {
            calls.push("publish");
            return {
              async dispose() {
                calls.push("plugin.dispose");
                return { revoked: ["res-1"], failed: [] };
              },
            };
          },
          async rollback() {
            calls.push("rollback");
          },
        };
      },
    };
    const base = {
      pluginId: "demo.toggle",
      manifest: discovered.manifest,
      module,
      moduleRef: moduleRefFromSource("demo-toggle-v1"),
      resolveSecret: () => "unused",
    };
    const settings = { keep: "my-settings" };

    // 生产入口：config.enabled=true → 完整注册事务
    const on = await applyEnabledChange(host, store, {
      ...base,
      config: { enabled: true, settings, environment: [], credentialRefs: {} },
    });
    expect(on.state).toBe("active");
    expect(host.publishedResources("demo.toggle")).toHaveLength(1);

    // 生产入口：enabled true→false → 完整卸载；能力与资源不可达 设置仍在
    const off = await applyEnabledChange(host, store, {
      ...base,
      config: { enabled: false, settings, environment: [], credentialRefs: {} },
    });
    expect(off.state).toBe("disposed");
    expect(host.publishedResources("demo.toggle")).toEqual([]);
    const parked = store.read("demo.toggle");
    expect(parked.enabled).toBe(false);
    expect((parked.config as { enabled: boolean }).enabled).toBe(false);
    expect((parked.config as { settings: unknown }).settings).toEqual(settings);
    expect(calls).toContain("resource.dispose");
    expect(calls).toContain("plugin.dispose");

    // 生产入口：false→true → 重新 validate/prepare/activate 不复用旧 handle
    const before = calls.length;
    const on2 = await applyEnabledChange(host, store, {
      ...base,
      config: { enabled: true, settings, environment: [], credentialRefs: {} },
    });
    expect(on2.state).toBe("active");
    expect(calls.slice(before)).toEqual(["prepare", "resource.activate", "publish"]);
    expect(host.publishedResources("demo.toggle")).toHaveLength(1);

    // 生产入口：prepare 失败 → blocked 后仍可显式停用（153/30F 回归）
    const blockedBase = {
      ...base,
      pluginId: "demo.blocked",
      module: {
        async prepare(): Promise<import("../../src/plugin/types.ts").PreparedPlugin> {
          throw new Error("prepare failed on purpose");
        },
      },
    };
    const failedOn = await applyEnabledChange(host, store, {
      ...blockedBase,
      config: { enabled: true, settings, environment: [], credentialRefs: {} },
    });
    expect(failedOn).toMatchObject({ state: "blocked", reasonCode: "PREPARE_FAILED" });
    const off2 = await applyEnabledChange(host, store, {
      ...blockedBase,
      config: { enabled: false, settings, environment: [], credentialRefs: {} },
    });
    expect(off2.state).toBe("disposed");
    const parked2 = store.read("demo.blocked");
    expect(parked2.lifecycleState).toBe("disposed");
    expect(parked2.enabled).toBe(false);
    expect((parked2.config as { enabled: boolean }).enabled).toBe(false);
    expect((parked2.config as { settings: unknown }).settings).toEqual(settings);
    expect(host.publishedResources("demo.blocked")).toEqual([]);

    // 崩溃窗回归（153/33F）：停用意图随 dispose 事务第一笔写盘——终态一旦 completed 必已双 false，
    // 不依赖 host 返回后的补写；active 与 blocked 两路各验一例。
    const crashCases = [
      { id: "demo.crash-active", module },
      { id: "demo.crash-blocked", module: blockedBase.module },
    ] as const;
    for (const crashCase of crashCases) {
      const crashDir = join(root, `store-a07-${seq++}`);
      const crashStore = new PluginOperationStore(crashDir);
      const crashHost = new PluginTransactionHost({
        store: crashStore,
        newOperationId: () => `op-${seq++}`,
      });
      const crashBase = { ...base, pluginId: crashCase.id, module: crashCase.module };
      await applyEnabledChange(crashHost, crashStore, {
        ...crashBase,
        config: { enabled: true, settings, environment: [], credentialRefs: {} },
      });
      const realSave = crashStore.save.bind(crashStore);
      crashStore.save = (record: Parameters<typeof realSave>[0]) => {
        realSave(record);
        if (record.lifecycleState === "disposed" && record.operation.phase === "completed") {
          throw new Error("crash after final save");
        }
      };
      await expect(
        applyEnabledChange(crashHost, crashStore, {
          ...crashBase,
          config: { enabled: false, settings, environment: [], credentialRefs: {} },
        }),
      ).rejects.toThrow("crash after final save");
      const reopened = new PluginOperationStore(crashDir).read(crashCase.id);
      expect(reopened.lifecycleState).toBe("disposed");
      expect(reopened.operation.phase).toBe("completed");
      expect(reopened.enabled).toBe(false);
      expect((reopened.config as { enabled: boolean }).enabled).toBe(false);
      expect((reopened.config as { settings: unknown }).settings).toEqual(settings);
    }
  });

  it("[PV0-A08] plugin id 封口", async () => {
    for (const bad of ["Demo", "de mo", "de/mo", "../evil"]) {
      const r = await discoverPlugin(await pkg(manifestOf({ id: bad })), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
    // 冲突半场之一（discovery 预检）：现役集合由调用方自报，这只是 import 前的早退。
    // 权威闸在事务写盘入口（PR#97 评审①），取证于 tests/pv0/pv0-a08-write-gate.test.ts。
    const conflicted = await discoverPlugin(await pkg(manifestOf({ id: "already.active" })), {
      hostVersion: HOST.hostVersion,
      activeIds: new Set(["already.active"]),
    });
    expect(conflicted).toMatchObject({ ok: false, reasonCode: "PLUGIN_ID_CONFLICT" });
    expect(probeCount()).toBe(0); // 不加载代码
  });

  it("[PV0-A09] env 绑定形状不可混用", async () => {
    const dir = await pkg(
      manifestOf({
        env: [
          { name: "PLAIN", description: "", required: true, secret: false },
          { name: "SECRET", description: "", required: true, secret: true },
        ],
      }),
    );
    const discovered = await discoverPlugin(dir, HOST);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    const base = { enabled: true, settings: {}, credentialRefs: {} };

    const good = checkInstanceConfig(discovered.manifest, {
      ...base,
      environment: [
        { name: "PLAIN", value: "x" },
        { name: "SECRET", secretRef: "vault:s" },
      ],
    });
    expect(good.ok).toBe(true); // secret×secretRef 与 plain×value：唯二合法组合

    const secretByValue = checkInstanceConfig(discovered.manifest, {
      ...base,
      environment: [
        { name: "PLAIN", value: "x" },
        { name: "SECRET", value: "SECRET_SHOULD_NEVER_APPEAR" },
      ],
    });
    expect(secretByValue).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });

    const plainByRef = checkInstanceConfig(discovered.manifest, {
      ...base,
      environment: [
        { name: "PLAIN", secretRef: "vault:p" },
        { name: "SECRET", secretRef: "vault:s" },
      ],
    });
    expect(plainByRef).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
    // 明文 secret 不进入配置快照：判定层直接拒绝，本层不产生任何快照。
  });

  it("[PV0-A10] env 只经 context 交付", async () => {
    const manifest = (
      (await discoverPlugin(
        await pkg(
          manifestOf({
            id: "demo.envonly",
            env: [
              { name: "A", description: "", required: true, secret: false },
              { name: "B", description: "", required: true, secret: true },
              { name: "C", description: "", required: false, secret: false },
            ],
          }),
        ),
        HOST,
      )) as { ok: true; manifest: import("../../src/plugin/manifest.ts").PluginManifestV0 }
    ).manifest;

    const goodConfig = {
      enabled: true,
      settings: {},
      environment: [
        { name: "A", value: "plain-a" },
        { name: "B", secretRef: "vault:b" },
      ],
      credentialRefs: {},
    };
    const assembled = resolveEnvironment(manifest, goodConfig, () => "SECRET_SHOULD_NEVER_APPEAR");
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    process.env.D = "process-env-probe";
    const store = new PluginOperationStore(join(root, `store-a10-${seq++}`));
    const host = new PluginTransactionHost({ store, newOperationId: () => `op-${seq++}` });
    let seenKeys: string[] = [];
    let seenB = "";
    let seenProcessD = "";
    const module: PluginModuleV0 = {
      async prepare(context) {
        seenKeys = Object.keys(context.env).sort();
        seenB = context.env.B ?? "";
        // 插件自录探针（PR#97 评审②）：同进程下 process.env 对插件天然可见——本条
        // 主张的是「宿主不经 context 交付 D」，不是「插件取不到 D」；隔离不在单B范围。
        seenProcessD = process.env.D ?? "";
        return {
          async activate() {
            return {
              async dispose() {
                return { revoked: [], failed: [] };
              },
            };
          },
          async rollback() {},
        };
      },
    };
    // 真实交付（PR#97 评审②）：走 applyEnabledChange 生产入口 + 生产 instance config
    // 形状，不再手拼 config 直捅 host.activate；权威快照因此携带真实 secretRef 绑定。
    const outcome = await applyEnabledChange(host, store, {
      pluginId: "demo.envonly",
      manifest,
      module,
      moduleRef: moduleRefFromSource("demo-envonly-v1"),
      config: goodConfig,
      resolveSecret: () => "SECRET_SHOULD_NEVER_APPEAR",
    });
    expect(outcome.state).toBe("active");
    // context.env 恰为 {A, B}（B 为已解析值）不含 C/D
    expect(seenKeys).toEqual(["A", "B"]);
    expect(seenB).toBe("SECRET_SHOULD_NEVER_APPEAR");
    expect(seenProcessD).toBe("process-env-probe"); // 同进程可见＝隔离不被本条冒领
    expect(assembled.env).not.toHaveProperty("C");
    expect(assembled.env).not.toHaveProperty("D");
    // 配置快照（磁盘权威文件）中 B 的解析值不出现；题面「日志与事件」两个 sink 本仓
    // 尚不存在、无从扫描——那一半按阻塞申报（PR 正文 61 题表 A10 行），不冒充绿。
    const snapshot = readFileSync(store.pathFor("demo.envonly"), "utf8");
    expect(snapshot).not.toContain("SECRET_SHOULD_NEVER_APPEAR");
    expect(snapshot).toContain("vault:b"); // 生产 config 形状真的落了盘（secretRef 而非解析值）
    // 漏交 required：REQUIREMENT_MISSING
    const missingRequired = resolveEnvironment(
      manifest,
      { ...goodConfig, environment: [{ name: "A", value: "plain-a" }] },
      () => "x",
    );
    expect(missingRequired).toMatchObject({ ok: false, reasonCode: "REQUIREMENT_MISSING" });
    Reflect.deleteProperty(process.env, "D");
  });
});
