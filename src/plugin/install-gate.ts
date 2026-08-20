/**
 * 插件协议 v0 —— 安装写盘门（RFC §2「不能靠后装覆盖前装」/ §8 `PLUGIN_ID_CONFLICT`）。
 *
 * PR #97 评审①落点：discovery 的 checkIdConflict 只能挡「调用方自报的」现役集合，
 * 事务层必须自己再读一次真账。本门由 PluginTransactionHost.activate 在落任何一笔
 * 权威记录之前调用，现役判定读两本真源：
 * - 本进程活着的 runtime（active handles）；
 * - 权威 store 里 lifecycleState === "active" 的持久记录（进程重启后、recovery
 *   接管前，同样受保护）。
 * 拒装即返回 `PLUGIN_ID_CONFLICT` 且零写盘——现役插件的记录、runtime、资源一概不动
 * （§8 终态「blocked，现役插件不变」；blocked 的是本次安装企图，不是现役方）。
 * 合法的同 id 复用不经本门变红：blocked 显式重试与 disposed 后重装，其旧账
 * lifecycleState 已非 active；显式 upgrade（E 区）另有入口，不借普通安装的门。
 */

import { transition } from "./lifecycle.ts";
import type { PluginOperationStore } from "./operation-store.ts";

/** 写盘门拒装收据：无 operationId——被拒的安装企图不产生任何事务账。 */
export interface PluginActivateRefusal {
  readonly pluginId: string;
  readonly state: "blocked";
  readonly reasonCode: "PLUGIN_ID_CONFLICT";
  readonly detail: string;
}

/** 普通安装撞现役 id → 拒装收据；无冲突 → null。只读判定，绝不写盘。 */
export function refuseActiveIdOverwrite(
  pluginId: string,
  liveRuntimeIds: { has(id: string): boolean },
  store: Pick<PluginOperationStore, "read">,
): PluginActivateRefusal | null {
  if (!liveRuntimeIds.has(pluginId) && !hasActiveAuthorityRecord(store, pluginId)) {
    return null;
  }
  // 状态推进不自造：本次安装企图站在 validated（校验后、prepare 前），走表取 blocked。
  const edge = transition("validated", "fail");
  if (!edge.ok || edge.state !== "blocked") {
    throw new Error("lifecycle table lost the validated→blocked edge");
  }
  return {
    pluginId,
    state: edge.state,
    reasonCode: "PLUGIN_ID_CONFLICT",
    detail: `plugin id already active: ${pluginId}; normal install must not overwrite an active plugin (explicit upgrade only)`,
  };
}

function hasActiveAuthorityRecord(
  store: Pick<PluginOperationStore, "read">,
  pluginId: string,
): boolean {
  try {
    return store.read(pluginId).lifecycleState === "active";
  } catch {
    // 无账或账不可读＝非现役，与 enable.ts readIfPresent 同口径；坏账的裁决权
    // 属 recovery/巡检，本门不越权替它定生死。
    return false;
  }
}
