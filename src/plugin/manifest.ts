/**
 * 插件协议 v0 —— manifest（§2）类型与纯校验层。
 *
 * 铁律（RFC §2 / 考卷 A 系）：manifest 是安装前唯一入口，校验发生在 import 任何插件
 * 代码之前——所以这一层是纯函数：吃解析好的 JSON 值，不碰文件系统，不 import，
 * 不产生副作用（PV0-A06 的结构性保证）。
 *
 * reason code 分工照 §8 表，一码不造：
 * - 未知 manifestSchemaVersion / requiresMist 不可解析或不匹配 → HOST_INCOMPATIBLE
 * - 字段形态、路径逃逸、未知枚举、重复 id、非法 plugin id → MANIFEST_INVALID
 * - 普通安装撞现役 id → PLUGIN_ID_CONFLICT
 * - env 绑定形状错配 → CONFIG_INVALID；缺 required → REQUIREMENT_MISSING
 */

import { parseRange, parseSemVer, satisfies } from "./semver.ts";
import type { HostServiceRequirement, ReasonCode } from "./types.ts";

export type PluginKind = "channel_adapter" | "frontend" | "tool_capability" | "bridge";
export type Effect = "read" | "reversible" | "irreversible";
export type InjectionMode = "eager" | "lazy";
export type CredentialType = "claude_oauth" | "codex_oauth" | "grok_oauth" | "api_key";

export interface CapabilityDeclaration {
  readonly id: string;
  readonly description: string;
  readonly effect: Effect;
  readonly operations: readonly string[];
  readonly injectionMode: InjectionMode;
}

export interface ContextInjectionDeclaration {
  readonly id: string;
  readonly source: string;
  readonly scope: "resident" | "session";
}

export interface EnvironmentDeclaration {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
}

export interface CredentialRequirement {
  readonly slot: string;
  readonly accepts: readonly CredentialType[];
  readonly required: boolean;
}

export interface PermissionGrant {
  readonly capabilityId: string;
  readonly effect: Effect;
  readonly operations: readonly string[];
  readonly literals?: Readonly<Record<string, readonly string[]>>;
}

export interface PluginManifestV0 {
  readonly manifestSchemaVersion: 0;
  readonly id: string;
  readonly version: string;
  readonly requiresMist: string;
  readonly entrypoint: string;
  readonly kinds: readonly PluginKind[];
  readonly configSchemaVersion: number;
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly contextInjections: readonly ContextInjectionDeclaration[];
  readonly env: readonly EnvironmentDeclaration[];
  readonly hostServices?: readonly HostServiceRequirement[];
  readonly credentials: readonly CredentialRequirement[];
  readonly permissions: readonly PermissionGrant[];
}

export interface CredentialRef {
  readonly id: string;
  readonly type: CredentialType;
  readonly issuerId: string;
}

export interface EnvironmentBinding {
  readonly name: string;
  readonly value?: string;
  readonly secretRef?: string;
}

export interface PluginInstanceConfig {
  readonly enabled: boolean;
  readonly settings: unknown;
  readonly environment: readonly EnvironmentBinding[];
  readonly credentialRefs: Readonly<Record<string, CredentialRef>>;
}

/** 校验结果 —— 与 lifecycle 的 TransitionResult 同一种 Result 风格。 */
export type ManifestValidation =
  | { readonly ok: true; readonly manifest: PluginManifestV0 }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly detail: string };

const PLUGIN_ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const KINDS: readonly PluginKind[] = ["channel_adapter", "frontend", "tool_capability", "bridge"];
const EFFECTS: readonly Effect[] = ["read", "reversible", "irreversible"];
const INJECTION_MODES: readonly InjectionMode[] = ["eager", "lazy"];
const INJECTION_SCOPES = ["resident", "session"] as const;
const CREDENTIAL_TYPES: readonly CredentialType[] = [
  "claude_oauth",
  "codex_oauth",
  "grok_oauth",
  "api_key",
];

function invalid(detail: string): ManifestValidation {
  return { ok: false, reasonCode: "MANIFEST_INVALID", detail };
}

function incompatible(detail: string): ManifestValidation {
  return { ok: false, reasonCode: "HOST_INCOMPATIBLE", detail };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * 包内相对路径封口（PV0-A04）：拒绝绝对路径、盘符、反斜杠、空段与任何 `..` 段；
 * 归一化后必须仍留在插件根之内。纯字符串判定，不触盘。
 */
export function isSealedRelativePath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.startsWith("\\")) return false;
  // 控制字符冻结策略（②段互审反例三）：NUL 会让 Node 文件 API 在后场炸
  // ERR_INVALID_ARG_VALUE，不是 fail-closed；一并冻结全部 C0 控制符与 DEL——
  // 路径里没有任何合法理由出现它们。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里就是要拒绝控制字符
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.includes("\\")) return false;
  const segments = p.split("/");
  let depth = 0;
  for (const seg of segments) {
    if (seg === "" || seg === ".") return false; // 空段与冗余 `.` 一律拒，形态即契约
    if (seg === "..") return false;
    depth += 1;
  }
  return depth > 0;
}

/**
 * 校验 manifest（纯数据 → 已定型结构）。
 * `hostVersion` 是宿主自己的 SemVer（用于 requiresMist 匹配），由引擎层注入；
 * 传不合法的 hostVersion 属宿主自身缺陷，直接抛错而非归罪插件。
 */
export function validateManifest(raw: unknown, hostVersion: string): ManifestValidation {
  const host = parseSemVer(hostVersion);
  if (host === null) {
    throw new Error(`host version is not strict SemVer: ${hostVersion}`);
  }
  if (!isRecord(raw)) {
    return invalid("manifest must be a plain JSON object");
  }

  // —— 兼容性两问先行（§8：HOST_INCOMPATIBLE 只属于这两处）——
  if (raw.manifestSchemaVersion !== 0) {
    return incompatible(`unknown manifestSchemaVersion: ${String(raw.manifestSchemaVersion)}`);
  }
  if (typeof raw.requiresMist !== "string") {
    return incompatible("requiresMist must be a string SemVer range");
  }
  const range = parseRange(raw.requiresMist);
  if (range === null) {
    return incompatible(`requiresMist range is not parseable: ${raw.requiresMist}`);
  }
  if (!satisfies(host, range)) {
    return incompatible(`host ${hostVersion} does not satisfy requiresMist ${raw.requiresMist}`);
  }

  // —— 字段与枚举封口（MANIFEST_INVALID）——
  if (typeof raw.id !== "string" || !PLUGIN_ID_RE.test(raw.id)) {
    return invalid(`plugin id violates ^[a-z0-9]+(?:[._-][a-z0-9]+)*$: ${String(raw.id)}`);
  }
  if (typeof raw.version !== "string" || parseSemVer(raw.version) === null) {
    return invalid(`version must be full SemVer: ${String(raw.version)}`);
  }
  if (typeof raw.entrypoint !== "string" || !isSealedRelativePath(raw.entrypoint)) {
    return invalid(`entrypoint must be a sealed package-relative path: ${String(raw.entrypoint)}`);
  }
  if (!Array.isArray(raw.kinds) || raw.kinds.length === 0) {
    return invalid("kinds must be a non-empty array");
  }
  for (const k of raw.kinds) {
    if (!KINDS.includes(k as PluginKind)) {
      return invalid(`unknown plugin kind: ${String(k)}`);
    }
  }
  if (
    typeof raw.configSchemaVersion !== "number" ||
    !Number.isSafeInteger(raw.configSchemaVersion) ||
    raw.configSchemaVersion < 0
  ) {
    // isSafeInteger 而非 isInteger（153/19F 反例二）：JSON 的 2^53 与 2^53+1 会折叠成
    // 同一个 Number，schema 身份随之别名——超安全整数一律拒。
    return invalid("configSchemaVersion must be a non-negative safe integer");
  }

  if (!Array.isArray(raw.capabilities)) return invalid("capabilities must be an array");
  const capabilityIds = new Set<string>();
  for (const c of raw.capabilities) {
    if (!isRecord(c)) return invalid("capability declaration must be an object");
    if (typeof c.id !== "string" || c.id === "") return invalid("capability id must be a string");
    if (capabilityIds.has(c.id)) return invalid(`duplicate capability id: ${c.id}`);
    capabilityIds.add(c.id);
    if (typeof c.description !== "string") return invalid(`capability ${c.id}: description`);
    if (!EFFECTS.includes(c.effect as Effect)) {
      return invalid(`capability ${c.id}: unknown effect ${String(c.effect)}`);
    }
    if (!isStringArray(c.operations)) return invalid(`capability ${c.id}: operations`);
    if (!INJECTION_MODES.includes(c.injectionMode as InjectionMode)) {
      return invalid(`capability ${c.id}: unknown injectionMode ${String(c.injectionMode)}`);
    }
  }

  if (!Array.isArray(raw.contextInjections)) return invalid("contextInjections must be an array");
  const injectionIds = new Set<string>();
  for (const inj of raw.contextInjections) {
    if (!isRecord(inj)) return invalid("context injection must be an object");
    if (typeof inj.id !== "string" || inj.id === "") return invalid("context injection id");
    if (injectionIds.has(inj.id)) return invalid(`duplicate context injection id: ${inj.id}`);
    injectionIds.add(inj.id);
    if (typeof inj.source !== "string" || !isSealedRelativePath(inj.source)) {
      return invalid(`context injection ${inj.id}: source must be sealed package-relative`);
    }
    if (!INJECTION_SCOPES.includes(inj.scope as (typeof INJECTION_SCOPES)[number])) {
      return invalid(`context injection ${inj.id}: unknown scope ${String(inj.scope)}`);
    }
  }

  if (!Array.isArray(raw.env)) return invalid("env must be an array");
  const envNames = new Set<string>();
  for (const e of raw.env) {
    if (!isRecord(e)) return invalid("env declaration must be an object");
    if (typeof e.name !== "string" || e.name === "") return invalid("env name must be a string");
    if (envNames.has(e.name)) return invalid(`duplicate env name: ${e.name}`);
    envNames.add(e.name);
    if (typeof e.description !== "string") return invalid(`env ${e.name}: description`);
    if (typeof e.required !== "boolean") return invalid(`env ${e.name}: required`);
    if (typeof e.secret !== "boolean") return invalid(`env ${e.name}: secret`);
  }

  if (raw.hostServices !== undefined) {
    if (!Array.isArray(raw.hostServices)) return invalid("hostServices must be an array");
    const serviceIds = new Set<string>();
    for (const service of raw.hostServices) {
      if (!isRecord(service)) return invalid("host service requirement must be an object");
      if (typeof service.id !== "string" || !PLUGIN_ID_RE.test(service.id)) {
        return invalid(`host service id is invalid: ${String(service.id)}`);
      }
      if (serviceIds.has(service.id)) return invalid(`duplicate host service id: ${service.id}`);
      serviceIds.add(service.id);
      if (typeof service.requires !== "string" || parseRange(service.requires) === null) {
        return invalid(`host service ${service.id}: requires must be a supported SemVer range`);
      }
    }
  }

  if (!Array.isArray(raw.credentials)) return invalid("credentials must be an array");
  const slots = new Set<string>();
  for (const cred of raw.credentials) {
    if (!isRecord(cred)) return invalid("credential requirement must be an object");
    if (typeof cred.slot !== "string" || cred.slot === "") return invalid("credential slot");
    if (slots.has(cred.slot)) return invalid(`duplicate credential slot: ${cred.slot}`);
    slots.add(cred.slot);
    if (!Array.isArray(cred.accepts) || cred.accepts.length === 0) {
      return invalid(`credential ${cred.slot}: accepts must be non-empty`);
    }
    for (const t of cred.accepts) {
      if (!CREDENTIAL_TYPES.includes(t as CredentialType)) {
        return invalid(`credential ${cred.slot}: unknown type ${String(t)}`);
      }
    }
    if (typeof cred.required !== "boolean") return invalid(`credential ${cred.slot}: required`);
  }

  if (!Array.isArray(raw.permissions)) return invalid("permissions must be an array");
  for (const p of raw.permissions) {
    if (!isRecord(p)) return invalid("permission grant must be an object");
    if (typeof p.capabilityId !== "string" || p.capabilityId === "") {
      return invalid("permission capabilityId");
    }
    if (!EFFECTS.includes(p.effect as Effect)) {
      return invalid(`permission ${p.capabilityId}: unknown effect ${String(p.effect)}`);
    }
    if (!isStringArray(p.operations)) return invalid(`permission ${p.capabilityId}: operations`);
    if (p.literals !== undefined) {
      if (!isRecord(p.literals)) return invalid(`permission ${p.capabilityId}: literals`);
      for (const [key, vals] of Object.entries(p.literals)) {
        if (!isStringArray(vals)) {
          return invalid(`permission ${p.capabilityId}: literals.${key} must be string[]`);
        }
      }
    }
  }

  return { ok: true, manifest: raw as unknown as PluginManifestV0 };
}

/**
 * 普通安装的 id 冲突判定（PV0-A08 后半）：撞现役 id → PLUGIN_ID_CONFLICT。
 * 显式 upgrade 不走这里（E 区事务另有入口）。
 */
export function checkIdConflict(
  id: string,
  activeIds: ReadonlySet<string>,
): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode } {
  if (activeIds.has(id)) {
    return { ok: false, reasonCode: "PLUGIN_ID_CONFLICT" };
  }
  return { ok: true };
}

export type BindingValidation =
  | { readonly ok: true; readonly resolvedNames: readonly string[] }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly detail: string };

function bindingInvalid(detail: string): BindingValidation {
  return { ok: false, reasonCode: "CONFIG_INVALID", detail };
}

/**
 * env 绑定形状与完备性（PV0-A05 / PV0-A09），纯判定不解析 secret：
 * - secret:true 只允许 secretRef；secret:false 只允许 value；错配 → CONFIG_INVALID
 * - 绑定了 manifest 未声明的名字 → CONFIG_INVALID（未声明的名字不得出现）
 * - required 声明缺绑定 → REQUIREMENT_MISSING；optional 缺绑定合法（不出现在交付集）
 * - required credential slot 缺 ref → REQUIREMENT_MISSING；未知 slot 的 ref → CONFIG_INVALID
 * 返回的 resolvedNames 即今后 `context.env` 的键集合（PV0-A10 的交付面由引擎层实现）。
 *
 * 入口吃 `unknown`（②段互审反例二）：instance config 是住户 JSON，运行时形状必须在此
 * 完整定型——容器不对、value/secretRef 非字符串、credential ref 缺字段，一律
 * CONFIG_INVALID fail-closed，绝不 TypeError 炸出去，也绝不放数字冒充 secretRef。
 */
export function validateBindings(manifest: PluginManifestV0, config: unknown): BindingValidation {
  if (!isRecord(config)) {
    return bindingInvalid("instance config must be a plain JSON object");
  }
  if (typeof config.enabled !== "boolean") {
    return bindingInvalid("instance config: enabled must be boolean");
  }
  if (!Array.isArray(config.environment)) {
    return bindingInvalid("instance config: environment must be an array");
  }
  if (!isRecord(config.credentialRefs)) {
    return bindingInvalid("instance config: credentialRefs must be an object");
  }
  const environment: unknown[] = config.environment;
  const credentialRefs: Record<string, unknown> = config.credentialRefs;

  const declared = new Map(manifest.env.map((e) => [e.name, e]));
  const bound = new Set<string>();
  for (const rawBinding of environment) {
    if (!isRecord(rawBinding)) {
      return bindingInvalid("environment binding must be an object");
    }
    if (typeof rawBinding.name !== "string" || rawBinding.name === "") {
      return bindingInvalid("environment binding: name must be a non-empty string");
    }
    if (rawBinding.value !== undefined && typeof rawBinding.value !== "string") {
      return bindingInvalid(`env ${rawBinding.name}: value must be a string when present`);
    }
    if (
      rawBinding.secretRef !== undefined &&
      (typeof rawBinding.secretRef !== "string" || rawBinding.secretRef === "")
    ) {
      return bindingInvalid(
        `env ${rawBinding.name}: secretRef must be a non-empty string when present`,
      );
    }
    const b = rawBinding as { name: string; value?: string; secretRef?: string };
    const decl = declared.get(b.name);
    if (decl === undefined) {
      return {
        ok: false,
        reasonCode: "CONFIG_INVALID",
        detail: `binding for undeclared env name: ${b.name}`,
      };
    }
    if (bound.has(b.name)) {
      return { ok: false, reasonCode: "CONFIG_INVALID", detail: `duplicate binding: ${b.name}` };
    }
    bound.add(b.name);
    const hasValue = b.value !== undefined;
    const hasRef = b.secretRef !== undefined;
    if (hasValue === hasRef) {
      return {
        ok: false,
        reasonCode: "CONFIG_INVALID",
        detail: `env ${b.name}: exactly one of value/secretRef is required`,
      };
    }
    if (decl.secret && hasValue) {
      return {
        ok: false,
        reasonCode: "CONFIG_INVALID",
        detail: `env ${b.name}: secret env must bind secretRef, not plaintext value`,
      };
    }
    if (!decl.secret && hasRef) {
      return {
        ok: false,
        reasonCode: "CONFIG_INVALID",
        detail: `env ${b.name}: non-secret env must bind value, not secretRef`,
      };
    }
  }
  for (const e of manifest.env) {
    if (e.required && !bound.has(e.name)) {
      return {
        ok: false,
        reasonCode: "REQUIREMENT_MISSING",
        detail: `required env not bound: ${e.name}`,
      };
    }
  }
  for (const [slot, rawRef] of Object.entries(credentialRefs)) {
    if (!manifest.credentials.some((c) => c.slot === slot)) {
      return bindingInvalid(`credential ref for undeclared slot: ${slot}`);
    }
    if (
      !isRecord(rawRef) ||
      typeof rawRef.id !== "string" ||
      rawRef.id === "" ||
      typeof rawRef.type !== "string" ||
      !CREDENTIAL_TYPES.includes(rawRef.type as CredentialType) ||
      typeof rawRef.issuerId !== "string" ||
      rawRef.issuerId === ""
    ) {
      return bindingInvalid(`credential ref for slot ${slot} is malformed`);
    }
  }
  for (const cred of manifest.credentials) {
    const rawRef = credentialRefs[cred.slot];
    if (rawRef === undefined) {
      if (cred.required) {
        return {
          ok: false,
          reasonCode: "REQUIREMENT_MISSING",
          detail: `required credential slot not bound: ${cred.slot}`,
        };
      }
      continue;
    }
    const ref = rawRef as CredentialRef; // 形状已在上一段完整定型
    if (!cred.accepts.includes(ref.type)) {
      return {
        ok: false,
        reasonCode: "CREDENTIAL_TYPE_MISMATCH",
        detail: `slot ${cred.slot}: ref type ${ref.type} not in accepts`,
      };
    }
  }
  return { ok: true, resolvedNames: [...bound] };
}
