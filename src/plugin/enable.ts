/**
 * enabled 开关装配（RFC §2：`enabled: false` 保留设置但不进入 prepare；true→false 必须
 * 走完整卸载，false→true 必须重新校验并走完整注册事务，不能靠隐藏 UI 冒充停用）。
 *
 * 这是 instance config `enabled` 变更的**生产入口**（PV0-A07 的考点主语）：测试与上层
 * 一律经它驱动开关，不得手摇 host.activate/dispose 冒充。它只编排既有零件——
 * 就绪门（validateBindings）、env 装配（resolveEnvironment）、事务宿主（activate/dispose）
 * ——自己不发明任何新语义。
 */

import { type SecretResolver, resolveEnvironment } from "./environment.ts";
import { type PluginManifestV0, validateBindings } from "./manifest.ts";
import type { PluginOperationStore } from "./operation-store.ts";
import { type PluginOperationOutcome, operationOutcome } from "./recovery-coordinator.ts";
import type { PluginTransactionHost } from "./transaction-host.ts";
import type { PluginModuleV0, ReasonCode } from "./types.ts";

export interface EnabledChangeRequest {
  readonly pluginId: string;
  readonly manifest: PluginManifestV0;
  readonly module: PluginModuleV0;
  readonly moduleRef: string;
  /** instance config 全量（含 enabled 目标值）；运行时形状由就绪门定型。 */
  readonly config: unknown;
  readonly resolveSecret: SecretResolver;
}

export type EnabledChangeResult =
  | PluginOperationOutcome
  | {
      readonly pluginId: string;
      readonly state: "blocked";
      readonly reasonCode: ReasonCode;
      readonly detail: string;
    };

/**
 * 应用一次 enabled 变更。目标值取自 config.enabled 本身（配置即意图 无第二真源）：
 * - false：完整卸载（host.dispose 逆序撤资源+插件级 dispose）后把 enabled=false 连同
 *   本次全量 config 原子落权威记录（config.enabled 与顶层 enabled 不得分叉）——设置仍在
 *   能力与资源不可达；
 * - true：重新走完整链——就绪门 → env 装配 → 全新注册事务（新 operationId 不复用旧
 *   handle）；就绪门不过按其 reasonCode fail-closed 不进 prepare。
 */
export async function applyEnabledChange(
  host: PluginTransactionHost,
  store: PluginOperationStore,
  request: EnabledChangeRequest,
): Promise<EnabledChangeResult> {
  const gate = validateBindings(request.manifest, request.config);
  if (!gate.ok) {
    return {
      pluginId: request.pluginId,
      state: "blocked",
      reasonCode: gate.reasonCode,
      detail: gate.detail,
    };
  }
  const enabled = (request.config as { enabled: boolean }).enabled;

  if (!enabled) {
    // 停用意图随 dispose 事务第一笔写盘（153/33F）：host 返回时权威已双 false，无第二完成点。
    return host.dispose(request.pluginId, { config: request.config });
  }

  const existing = readIfPresent(store, request.pluginId);
  if (existing?.enabled && existing.lifecycleState === "active") {
    return operationOutcome(existing); // true→true：已在役 幂等返回 不重进事务
  }
  const assembled = resolveEnvironment(request.manifest, request.config, request.resolveSecret);
  if (!assembled.ok) {
    return {
      pluginId: request.pluginId,
      state: "blocked",
      reasonCode: assembled.reasonCode,
      detail: assembled.detail,
    };
  }
  return host.activate({
    pluginId: request.pluginId,
    moduleRef: request.moduleRef,
    module: request.module,
    config: request.config,
    env: assembled.env,
    bindings: { environment: (request.config as { environment: unknown }).environment },
    // PV0 占位：readiness gate（F01/F06）尚未实现，此空对象不是验证收据；
    // 接线前不得将其投影为 ready——消费者应视为 unverified。
    verifiedScope: {},
  });
}

function readIfPresent(store: PluginOperationStore, pluginId: string) {
  try {
    return store.read(pluginId);
  } catch {
    return null;
  }
}
