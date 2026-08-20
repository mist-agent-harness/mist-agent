/**
 * Plugin Protocol v0 — lifecycle state machine (pure, zero IO).
 *
 * Every edge below is copied from the RFC state diagram and its surrounding rules in
 * docs/design/plugin-protocol-v0.md §3 (frozen at the #62 merge, main@acdfcab2);
 * nothing here is invented. The table is data, `transition()` is a total pure function
 * over it, so PV0 tests and ②段's recovery coordinator can both consume it without
 * side effects.
 *
 *   discovered → validated → prepared → active → disposing → disposed
 *        └───────────┴───────────┴──────────┴──────────┴→ blocked
 *   prepared  ─ rollback → blocked（保留启用意图）
 *   disposing ─ dispose 不完整 → quarantined
 *   quarantined ─ 显式清理重试成功 → disposed；失败 → quarantined
 *   blocked ─ 显式修复/用户重试 → discovered（重走完整生命周期）
 *   blocked ─ 显式停用并清理 → disposing
 *
 * Explicitly forbidden (asserted by absence + tests, RFC §3 blocked/quarantined rules):
 * blocked → active direct, any automatic blocked → ready; quarantined 下重复 dispose
 * 幂等返回 quarantined，不算显式重试；disposed is terminal.
 */

export type LifecycleState =
  | "discovered"
  | "validated"
  | "prepared"
  | "active"
  | "disposing"
  | "disposed"
  | "blocked"
  | "quarantined";

export type LifecycleEvent =
  | "validate"
  | "prepare"
  | "activate"
  | "begin_dispose"
  | "dispose_complete"
  | "dispose_incomplete"
  | "fail"
  | "rollback"
  | "retry_from_blocked"
  | "deactivate_from_blocked"
  | "retry_cleanup_success"
  | "retry_cleanup_failure"
  | "dispose_while_quarantined";

export type TransitionResult =
  | { readonly ok: true; readonly state: LifecycleState }
  | { readonly ok: false; readonly from: LifecycleState; readonly event: LifecycleEvent };

type TransitionTable = {
  readonly [S in LifecycleState]?: { readonly [E in LifecycleEvent]?: LifecycleState };
};

/** Every legal edge of the v0 lifecycle. Data only — consult the header for RFC refs. */
export const LIFECYCLE_TRANSITIONS: TransitionTable = {
  discovered: {
    validate: "validated",
    fail: "blocked",
  },
  validated: {
    prepare: "prepared",
    fail: "blocked",
  },
  prepared: {
    activate: "active",
    rollback: "blocked",
    fail: "blocked",
  },
  active: {
    begin_dispose: "disposing",
    fail: "blocked",
  },
  disposing: {
    dispose_complete: "disposed",
    dispose_incomplete: "quarantined",
    fail: "blocked",
  },
  blocked: {
    retry_from_blocked: "discovered",
    deactivate_from_blocked: "disposing",
  },
  quarantined: {
    retry_cleanup_success: "disposed",
    retry_cleanup_failure: "quarantined",
    dispose_while_quarantined: "quarantined",
  },
  // disposed: terminal — no out-edges by design (absence is the assertion).
};

/** Pure transition: returns the next state, or a typed refusal for any edge not on the table. */
export function transition(state: LifecycleState, event: LifecycleEvent): TransitionResult {
  const next = LIFECYCLE_TRANSITIONS[state]?.[event];
  if (next === undefined) {
    return { ok: false, from: state, event };
  }
  return { ok: true, state: next };
}
