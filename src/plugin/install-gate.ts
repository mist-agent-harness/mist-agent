/**
 * 插件协议 v0 —— 安装写盘门（RFC §2「不能靠后装覆盖前装」/ §8 `PLUGIN_ID_CONFLICT`）。
 *
 * PR #97 评审①落点 + 153/51F 渡审修正：discovery 的 checkIdConflict 只能挡「调用方
 * 自报的」现役集合，事务层必须自己读真账。本门由 PluginTransactionHost.activate 在落
 * 任何一笔权威记录之前调用，按真账状态裁决，**fail-closed 是默认，放行是例外**：
 *
 * - 本进程有活 runtime，或持久账 `active`　→ `PLUGIN_ID_CONFLICT`（§8：现役插件不变）
 * - 账本文件不存在（仅 ENOENT）　　　　　 → 放行（真·无账）
 * - 账在但读不出（权限/JSON/schema 坏账）→ `LIFECYCLE_RECOVERY_PENDING` 拒装，
 *   原字节一动不动——坏账的裁决权在 recovery/巡检，绝不许普通安装把它洗成新账（51F 阻塞①）
 * - `blocked`（显式重试重走完整生命周期）/ `disposed`（terminal 后重装）→ 放行，
 *   这是 lifecycle 表上仅有的两扇合法复用门
 * - `validated`/`prepared`/`disposing`/`quarantined` 及任何未知状态 → `LIFECYCLE_RECOVERY_PENDING`
 *   拒装——在飞账归中断恢复、隔离账只认 retryCleanup（51F 阻塞②：quarantined 不得被洗成 active）
 *
 * 拒装即零写盘：现役/在飞/隔离方的记录、runtime、资源一概不动；blocked 的是本次安装
 * 企图，不是账的主人。显式 upgrade（E 区）另有入口，不借普通安装的门。
 */

import { transition } from "./lifecycle.ts";
import type { PluginOperationStore } from "./operation-store.ts";

/** 写盘门拒装收据：无 operationId——被拒的安装企图不产生任何事务账。 */
export interface PluginActivateRefusal {
  readonly pluginId: string;
  readonly state: "blocked";
  readonly reasonCode: "PLUGIN_ID_CONFLICT" | "LIFECYCLE_RECOVERY_PENDING" | "REQUIREMENT_MISSING";
  readonly detail: string;
}

/** 普通安装的写盘门裁决：拒装收据，或 null 放行。只读判定，绝不写盘。 */
export function refuseActiveIdOverwrite(
  pluginId: string,
  liveRuntimeIds: { has(id: string): boolean },
  store: Pick<PluginOperationStore, "read">,
): PluginActivateRefusal | null {
  if (liveRuntimeIds.has(pluginId)) {
    return refusal(
      pluginId,
      "PLUGIN_ID_CONFLICT",
      `plugin id already active in this process: ${pluginId}; normal install must not overwrite an active plugin (explicit upgrade only)`,
    );
  }
  let incumbentState: string;
  try {
    incumbentState = store.read(pluginId).lifecycleState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return null; // 只有「账本文件不存在」算无账
    }
    // 51F 阻塞①：权限/读取/JSON/schema 错误一律 fail-closed——原字节不动，交 recovery/巡检。
    return refusal(
      pluginId,
      "LIFECYCLE_RECOVERY_PENDING",
      `authority record for ${pluginId} exists but is unreadable; refusing normal install fail-closed — settle it via recovery/inspection, never by overwrite`,
    );
  }
  switch (incumbentState) {
    case "blocked": // 显式重试门：blocked ─retry─→ discovered 重走完整生命周期
    case "disposed": // 重装门：terminal 老账让位给全新事务
      return null;
    case "active":
      return refusal(
        pluginId,
        "PLUGIN_ID_CONFLICT",
        `plugin id already active: ${pluginId}; normal install must not overwrite an active plugin (explicit upgrade only)`,
      );
    default:
      // validated/prepared/disposing/quarantined（含未来新增状态，兜底 fail-closed）：
      // 在飞或待清理的账归 recovery/cleanup 裁决，普通安装不得洗写（51F 阻塞②）。
      return refusal(
        pluginId,
        "LIFECYCLE_RECOVERY_PENDING",
        `plugin ${pluginId} authority record is ${incumbentState}; normal install must wait for recovery/cleanup to settle it`,
      );
  }
}

function refusal(
  pluginId: string,
  reasonCode: PluginActivateRefusal["reasonCode"],
  detail: string,
): PluginActivateRefusal {
  // 状态推进不自造：本次安装企图站在 validated（校验后、prepare 前），走表取 blocked。
  const edge = transition("validated", "fail");
  if (!edge.ok || edge.state !== "blocked") {
    throw new Error("lifecycle table lost the validated→blocked edge");
  }
  return { pluginId, state: edge.state, reasonCode, detail };
}
