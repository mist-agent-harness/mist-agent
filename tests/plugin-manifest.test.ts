import { describe, expect, it } from "vitest";
import {
  type PluginInstanceConfig,
  type PluginManifestV0,
  checkIdConflict,
  isSealedRelativePath,
  validateBindings,
  validateManifest,
} from "../src/plugin/manifest.ts";
import { parseRange, parseSemVer } from "../src/plugin/semver.ts";

/**
 * 纯函数层单测：覆盖 PV0-A 各判据在校验器上的形态。
 * PV0-A 考卷条目本身仍留在 tests/pv0/ 为 todo —— 那些条目要求「代码未加载/无资源注册/
 * 进入 discovered」等宿主装载面证据，等 install 引擎落地后连探针一起转正，不提前冒绿。
 */

const HOST = "0.4.0";

function minimalManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestSchemaVersion: 0,
    id: "demo.plugin-1",
    version: "1.2.3",
    requiresMist: ">=0.1.0",
    entrypoint: "dist/index.js",
    kinds: ["tool_capability"],
    configSchemaVersion: 1,
    capabilities: [],
    contextInjections: [],
    env: [],
    credentials: [],
    permissions: [],
    ...overrides,
  };
}

function asManifest(overrides: Record<string, unknown> = {}): PluginManifestV0 {
  const result = validateManifest(minimalManifest(overrides), HOST);
  if (!result.ok) throw new Error(`fixture invalid: ${result.detail}`);
  return result.manifest;
}

function config(overrides: Partial<PluginInstanceConfig> = {}): PluginInstanceConfig {
  return { enabled: true, settings: {}, environment: [], credentialRefs: {}, ...overrides };
}

describe("strict semver subset (RFC §2: 未知语法一律拒)", () => {
  it("parses full SemVer only", () => {
    expect(parseSemVer("1.2.3")).not.toBeNull();
    expect(parseSemVer("0.0.1-alpha.1")).not.toBeNull();
    for (const bad of ["v1.2.3", "1.2", "1", "1.02.3", "", "latest"]) {
      expect(parseSemVer(bad)).toBeNull();
    }
  });

  it("rejects unenumerated range syntax instead of guessing", () => {
    for (const bad of ["1.x", "*", ">=1.0.0 || >=2.0.0", "1.2.3 - 2.0.0", ">=1.2", "^v1.0.0", ""]) {
      expect(parseRange(bad)).toBeNull();
    }
    expect(parseRange(">=0.1.0 <2.0.0")).not.toBeNull();
    expect(parseRange("^0.4.0")).not.toBeNull();
    expect(parseRange("~1.4.2")).not.toBeNull();
  });
});

describe("validateManifest — 兼容性两问 (HOST_INCOMPATIBLE)", () => {
  it("[A02判据] unknown manifestSchemaVersion fail-closed", () => {
    const r = validateManifest(minimalManifest({ manifestSchemaVersion: 99 }), HOST);
    expect(r).toMatchObject({ ok: false, reasonCode: "HOST_INCOMPATIBLE" });
  });

  it("[A03判据] unparseable and unmatched requiresMist both refuse", () => {
    const unparseable = validateManifest(
      minimalManifest({ requiresMist: "1.x || nonsense" }),
      HOST,
    );
    expect(unparseable).toMatchObject({ ok: false, reasonCode: "HOST_INCOMPATIBLE" });
    const unmatched = validateManifest(minimalManifest({ requiresMist: ">=9.0.0" }), HOST);
    expect(unmatched).toMatchObject({ ok: false, reasonCode: "HOST_INCOMPATIBLE" });
  });
});

describe("validateManifest — 字段/路径/枚举/重复 id 封口 (MANIFEST_INVALID)", () => {
  it("[A01判据] four minimal kinds all validate", () => {
    for (const kind of ["channel_adapter", "frontend", "tool_capability", "bridge"]) {
      const r = validateManifest(minimalManifest({ kinds: [kind] }), HOST);
      expect(r.ok).toBe(true);
    }
  });

  it("[A08判据] plugin id sealing: uppercase / whitespace / separators / ../evil", () => {
    for (const bad of ["Demo", "de mo", "de/mo", "../evil", "de\\mo", "-lead", "trail-", ""]) {
      const r = validateManifest(minimalManifest({ id: bad }), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
  });

  it("[A04判据] entrypoint and injection source escapes refuse", () => {
    for (const bad of ["../up.js", "/abs.js", "a//b.js", "C:\\x.js", "dist\\x.js", "./x.js", ""]) {
      expect(isSealedRelativePath(bad)).toBe(false);
      const r = validateManifest(minimalManifest({ entrypoint: bad }), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
    const viaInjection = validateManifest(
      minimalManifest({
        contextInjections: [{ id: "guide", source: "../outside.md", scope: "resident" }],
      }),
      HOST,
    );
    expect(viaInjection).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
  });

  it("[A04判据] unknown kind / effect / injectionMode / scope refuse", () => {
    const badKind = validateManifest(minimalManifest({ kinds: ["gadget"] }), HOST);
    expect(badKind).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const badEffect = validateManifest(
      minimalManifest({
        capabilities: [
          { id: "c1", description: "", effect: "chaotic", operations: [], injectionMode: "eager" },
        ],
      }),
      HOST,
    );
    expect(badEffect).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const badMode = validateManifest(
      minimalManifest({
        capabilities: [
          { id: "c1", description: "", effect: "read", operations: [], injectionMode: "sometimes" },
        ],
      }),
      HOST,
    );
    expect(badMode).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const badScope = validateManifest(
      minimalManifest({ contextInjections: [{ id: "g", source: "g.md", scope: "global" }] }),
      HOST,
    );
    expect(badScope).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
  });

  it("[A04判据] duplicate capability / context injection ids refuse", () => {
    const dupCap = validateManifest(
      minimalManifest({
        capabilities: [
          { id: "c1", description: "", effect: "read", operations: [], injectionMode: "eager" },
          { id: "c1", description: "", effect: "read", operations: [], injectionMode: "lazy" },
        ],
      }),
      HOST,
    );
    expect(dupCap).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const dupInj = validateManifest(
      minimalManifest({
        contextInjections: [
          { id: "g", source: "a.md", scope: "resident" },
          { id: "g", source: "b.md", scope: "session" },
        ],
      }),
      HOST,
    );
    expect(dupInj).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
  });

  it("configSchemaVersion must be a non-negative integer", () => {
    for (const bad of [-1, 1.5, "1"]) {
      const r = validateManifest(minimalManifest({ configSchemaVersion: bad }), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
  });
});

describe("checkIdConflict — 普通安装撞现役 id (PV0-A08 后半判据)", () => {
  it("returns PLUGIN_ID_CONFLICT on active id, ok otherwise", () => {
    const active = new Set(["demo.plugin-1"]);
    expect(checkIdConflict("demo.plugin-1", active)).toMatchObject({
      ok: false,
      reasonCode: "PLUGIN_ID_CONFLICT",
    });
    expect(checkIdConflict("other.plugin", active)).toEqual({ ok: true });
  });
});

describe("validateBindings — env 形状与完备性 (PV0-A05 / PV0-A09 判据)", () => {
  const manifest = asManifest({
    env: [
      { name: "PLAIN", description: "", required: true, secret: false },
      { name: "SECRET", description: "", required: true, secret: true },
      { name: "OPTIONAL", description: "", required: false, secret: false },
    ],
  });

  it("[A09判据] only secret×secretRef and plain×value pass; mismatches CONFIG_INVALID", () => {
    const good = validateBindings(
      manifest,
      config({
        environment: [
          { name: "PLAIN", value: "x" },
          { name: "SECRET", secretRef: "vault:s1" },
        ],
      }),
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect([...good.resolvedNames].sort()).toEqual(["PLAIN", "SECRET"]);

    const secretByValue = validateBindings(
      manifest,
      config({
        environment: [
          { name: "PLAIN", value: "x" },
          { name: "SECRET", value: "SECRET_SHOULD_NEVER_APPEAR" },
        ],
      }),
    );
    expect(secretByValue).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });

    const plainByRef = validateBindings(
      manifest,
      config({
        environment: [
          { name: "PLAIN", secretRef: "vault:p" },
          { name: "SECRET", secretRef: "vault:s1" },
        ],
      }),
    );
    expect(plainByRef).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });

    const both = validateBindings(
      manifest,
      config({
        environment: [
          { name: "PLAIN", value: "x", secretRef: "vault:p" },
          { name: "SECRET", secretRef: "vault:s1" },
        ],
      }),
    );
    expect(both).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
  });

  it("[A05判据] required missing → REQUIREMENT_MISSING; optional missing passes and stays undelivered", () => {
    const missingRequired = validateBindings(
      manifest,
      config({ environment: [{ name: "PLAIN", value: "x" }] }),
    );
    expect(missingRequired).toMatchObject({ ok: false, reasonCode: "REQUIREMENT_MISSING" });

    const optionalAbsent = validateBindings(
      manifest,
      config({
        environment: [
          { name: "PLAIN", value: "x" },
          { name: "SECRET", secretRef: "vault:s1" },
        ],
      }),
    );
    expect(optionalAbsent.ok).toBe(true);
    if (optionalAbsent.ok) expect(optionalAbsent.resolvedNames).not.toContain("OPTIONAL");
  });

  it("binding an undeclared name refuses (未声明的名字不得出现)", () => {
    const r = validateBindings(
      manifest,
      config({
        environment: [
          { name: "PLAIN", value: "x" },
          { name: "SECRET", secretRef: "vault:s1" },
          { name: "GHOST", value: "boo" },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
  });

  it("[A05判据] credential slots: required missing / type mismatch / undeclared slot", () => {
    const withCred = asManifest({
      credentials: [{ slot: "brain", accepts: ["claude_oauth"], required: true }],
    });
    const missing = validateBindings(withCred, config());
    expect(missing).toMatchObject({ ok: false, reasonCode: "REQUIREMENT_MISSING" });

    const mismatch = validateBindings(
      withCred,
      config({ credentialRefs: { brain: { id: "r1", type: "api_key", issuerId: "i1" } } }),
    );
    expect(mismatch).toMatchObject({ ok: false, reasonCode: "CREDENTIAL_TYPE_MISMATCH" });

    const undeclared = validateBindings(
      withCred,
      config({
        credentialRefs: {
          brain: { id: "r1", type: "claude_oauth", issuerId: "i1" },
          ghost: { id: "r2", type: "api_key", issuerId: "i2" },
        },
      }),
    );
    expect(undeclared).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
  });
});

describe("153/19F 反例二回归：configSchemaVersion 非安全整数折叠", () => {
  it("JSON 原文 2^53 与 2^53+1 折叠为同一 Number——两者均按非安全整数拒绝", () => {
    // TS 字面量写不出 2^53+1（编译期即折叠 biome noPrecisionLoss 拦截）——
    // 真实攻击面是 JSON 原文经 JSON.parse 折叠 故回归走原文路径。
    for (const text of ["9007199254740992", "9007199254740993"]) {
      const folded = JSON.parse(`{"v":${text}}`) as { v: number };
      const r = validateManifest(minimalManifest({ configSchemaVersion: folded.v }), HOST);
      expect(r).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    }
    expect(
      validateManifest(minimalManifest({ configSchemaVersion: 9007199254740991 }), HOST).ok,
    ).toBe(true);
  });
});

describe("②段互审三反例回归（166/15F：大整数折叠 · 生 JSON 绑定 · NUL 路径）", () => {
  it("反例一：超 MAX_SAFE_INTEGER 的数字段拒绝解析 不折叠误比", () => {
    expect(parseSemVer("9007199254740992.0.0")).toBeNull();
    expect(parseSemVer("9007199254740993.0.0")).toBeNull();
    expect(parseSemVer("1.0.0-rc.9007199254740993")).toBeNull();
    expect(parseSemVer("9007199254740991.0.0")).not.toBeNull();
  });

  it("反例二：绑定层吃生 JSON——坏容器/非字符串 ref 一律 CONFIG_INVALID 不抛 TypeError", () => {
    const manifest = asManifest({
      env: [{ name: "SECRET", description: "", required: true, secret: true }],
      credentials: [{ slot: "brain", accepts: ["claude_oauth"], required: false }],
    });
    expect(
      validateBindings(manifest, {
        enabled: true,
        settings: {},
        environment: [{ name: "SECRET", secretRef: 42 }],
        credentialRefs: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
    expect(
      validateBindings(manifest, {
        enabled: true,
        settings: {},
        environment: null,
        credentialRefs: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
    expect(validateBindings(manifest, null)).toMatchObject({
      ok: false,
      reasonCode: "CONFIG_INVALID",
    });
    expect(validateBindings(manifest, "nope")).toMatchObject({
      ok: false,
      reasonCode: "CONFIG_INVALID",
    });
    expect(
      validateBindings(manifest, {
        enabled: true,
        settings: {},
        environment: [{ name: "SECRET", secretRef: "vault:s" }],
        credentialRefs: { brain: { id: "", type: "claude_oauth", issuerId: "i" } },
      }),
    ).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
    expect(
      validateBindings(manifest, {
        enabled: true,
        settings: {},
        environment: [{ name: "SECRET", secretRef: "vault:s" }],
        credentialRefs: "nope",
      }),
    ).toMatchObject({ ok: false, reasonCode: "CONFIG_INVALID" });
  });

  it("反例三：路径含 NUL/控制字符按 A04 fail-closed 不留给 Node 后场炸", () => {
    expect(isSealedRelativePath("dist/\u0000index.js")).toBe(false);
    expect(isSealedRelativePath("dist/\u0001x.js")).toBe(false);
    expect(isSealedRelativePath("dist/\u007fx.js")).toBe(false);
    const nulEntry = validateManifest(minimalManifest({ entrypoint: "dist/\u0000index.js" }), HOST);
    expect(nulEntry).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
    const nulSource = validateManifest(
      minimalManifest({
        contextInjections: [{ id: "g", source: "docs/\u0000g.md", scope: "resident" }],
      }),
      HOST,
    );
    expect(nulSource).toMatchObject({ ok: false, reasonCode: "MANIFEST_INVALID" });
  });
});
