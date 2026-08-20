/**
 * 插件协议 v0 —— discover/validate 装载层（§2 → §3 前半）。
 *
 * 职责边界（故意窄）：
 * - 只做「读纯数据 manifest → 校验 → 状态机推进到 validated / blocked」这一段；
 * - **绝不 import 插件代码**（PV0-A06：拒装必须发生在 import 之前——本模块内
 *   连 dynamic import 的调用点都不存在，探针测试据此取证）；
 * - prepare/activate 的事务语义属 ②段（operationId 账本），本层不碰持久化。
 *
 * 状态推进不自造：一律走 lifecycle.transition()，非法边由那张表拒绝。
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { type LifecycleState, transition } from "./lifecycle.ts";
import {
  type PluginManifestV0,
  checkIdConflict,
  validateBindings,
  validateManifest,
} from "./manifest.ts";
import type { ReasonCode } from "./types.ts";

/** manifest 文件名，RFC §2 钉死：包根目录纯数据文件。 */
export const MANIFEST_FILENAME = "mist-plugin.json";

export interface DiscoveryOk {
  readonly ok: true;
  readonly state: Extract<LifecycleState, "validated">;
  readonly manifest: PluginManifestV0;
}

export interface DiscoveryRefused {
  readonly ok: false;
  readonly state: Extract<LifecycleState, "blocked">;
  readonly reasonCode: ReasonCode;
  readonly detail: string;
}

export type DiscoveryResult = DiscoveryOk | DiscoveryRefused;

export interface DiscoveryHost {
  /** 宿主自身版本（requiresMist 匹配基准），严格 SemVer。 */
  readonly hostVersion: string;
  /** 现役插件 id 集合（普通安装撞现役 id → PLUGIN_ID_CONFLICT）。 */
  readonly activeIds: ReadonlySet<string>;
}

/**
 * 物理封口（②段互审 153/19F 反例一）：词法封口挡不住 symlink——包内 `dist` 软链到
 * 包外时 `dist/index.js` 词法干净却已逃根。故在 validated 之前对 entrypoint 与全部
 * context injection source 做 realpath 收容检查：包根与目标都取 canonical 真身，
 * 目标必须位于包根真身之内且为**普通文件**（regular-file 策略在此冻结：不是文件、
 * 不存在、或真身逃根 一律 MANIFEST_INVALID fail-closed）。指向包根之内的软链合法——
 * 不变量是「真身不出根」，不是「不许用链」。
 */
async function verifyContainedRegularFiles(
  packageDir: string,
  relativePaths: readonly string[],
): Promise<string | null> {
  let rootReal: string;
  try {
    rootReal = await realpath(packageDir);
  } catch {
    return `plugin package root is not resolvable: ${packageDir}`;
  }
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  for (const relativePath of relativePaths) {
    let targetReal: string;
    try {
      targetReal = await realpath(join(packageDir, relativePath));
    } catch {
      return `declared file is missing or unresolvable: ${relativePath}`;
    }
    if (!targetReal.startsWith(rootPrefix)) {
      return `declared file escapes the plugin root via symlink: ${relativePath}`;
    }
    try {
      const info = await stat(targetReal);
      if (!info.isFile()) {
        return `declared path is not a regular file: ${relativePath}`;
      }
    } catch {
      return `declared file is missing or unresolvable: ${relativePath}`;
    }
  }
  return null;
}

function refuse(reasonCode: ReasonCode, detail: string): DiscoveryRefused {
  // discovered --fail--> blocked：走表，不手写状态字面量。
  const t = transition("discovered", "fail");
  if (!t.ok) throw new Error("lifecycle table lost the discovered→blocked edge");
  return { ok: false, state: "blocked", reasonCode, detail };
}

/**
 * 从插件包目录发现并校验一个插件：读 mist-plugin.json（纯数据，不执行任何插件代码）、
 * 校验、判 id 冲突，推进到 validated。任何拒绝落 blocked + §8 reason code。
 */
export async function discoverPlugin(
  packageDir: string,
  host: DiscoveryHost,
): Promise<DiscoveryResult> {
  let text: string;
  try {
    text = await readFile(join(packageDir, MANIFEST_FILENAME), "utf8");
  } catch {
    return refuse("MANIFEST_INVALID", `missing or unreadable ${MANIFEST_FILENAME}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("MANIFEST_INVALID", `${MANIFEST_FILENAME} is not valid JSON`);
  }
  const validated = validateManifest(raw, host.hostVersion);
  if (!validated.ok) {
    return refuse(validated.reasonCode, validated.detail);
  }
  const containment = await verifyContainedRegularFiles(packageDir, [
    validated.manifest.entrypoint,
    ...validated.manifest.contextInjections.map((injection) => injection.source),
  ]);
  if (containment !== null) {
    return refuse("MANIFEST_INVALID", containment);
  }
  const conflict = checkIdConflict(validated.manifest.id, host.activeIds);
  if (!conflict.ok) {
    return refuse(conflict.reasonCode, `plugin id already active: ${validated.manifest.id}`);
  }
  const t = transition("discovered", "validate");
  if (!t.ok || t.state !== "validated") {
    throw new Error("lifecycle table lost the discovered→validated edge");
  }
  return { ok: true, state: "validated", manifest: validated.manifest };
}

/**
 * 实例配置就绪门（PV0-A05/A09 的引擎位）：validated 之后、prepare 之前调用。
 * 只做形状与完备性判定，不解析任何 secretRef 值——解析发生在执行边界（②段之后）。
 * 入口收 unknown：住户 JSON 的运行时形状由 validateBindings 完整定型 fail-closed。
 */
export function checkInstanceConfig(
  manifest: PluginManifestV0,
  config: unknown,
): ReturnType<typeof validateBindings> {
  return validateBindings(manifest, config);
}

/**
 * 能力目录的最小只读视图：只有 active 插件的能力才可枚举（RFC §3：任何可枚举入口
 * 都必须是已持久化 active 记录的子集）。本层尚无 activate 路径，因此对 validated
 * 插件恒为空——PV0-A01「校验后尚未出现在能力目录」由此取证。
 */
export function capabilityDirectory(
  records: ReadonlyMap<string, { state: LifecycleState; manifest: PluginManifestV0 }>,
): readonly { pluginId: string; capabilityId: string }[] {
  const entries: { pluginId: string; capabilityId: string }[] = [];
  for (const [pluginId, record] of records) {
    if (record.state !== "active") continue;
    for (const cap of record.manifest.capabilities) {
      entries.push({ pluginId, capabilityId: cap.id });
    }
  }
  return entries;
}
