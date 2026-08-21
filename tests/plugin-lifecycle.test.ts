import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_TRANSITIONS,
  type LifecycleEvent,
  type LifecycleState,
  transition,
} from "../src/plugin/lifecycle.ts";

const happyPath: ReadonlyArray<readonly [LifecycleState, LifecycleEvent, LifecycleState]> = [
  ["discovered", "validate", "validated"],
  ["validated", "prepare", "prepared"],
  ["prepared", "activate", "active"],
  ["active", "begin_dispose", "disposing"],
  ["disposing", "dispose_complete", "disposed"],
];

describe("plugin lifecycle transition table (RFC docs/design/plugin-protocol-v0.md)", () => {
  it("walks the main chain discovered → disposed (RFC §3 主链)", () => {
    for (const [from, event, to] of happyPath) {
      expect(transition(from, event)).toEqual({ ok: true, state: to });
    }
  });

  it("drops to blocked from every pre-terminal working state (RFC §3 状态图)", () => {
    const failable: LifecycleState[] = [
      "discovered",
      "validated",
      "prepared",
      "active",
      "disposing",
    ];
    for (const from of failable) {
      expect(transition(from, "fail")).toEqual({ ok: true, state: "blocked" });
    }
  });

  it("rolls back prepared to blocked, keeping intent out of band (RFC §3 rollback 边)", () => {
    expect(transition("prepared", "rollback")).toEqual({ ok: true, state: "blocked" });
  });

  it("routes incomplete dispose to quarantined (RFC §3 dispose 不完整)", () => {
    expect(transition("disposing", "dispose_incomplete")).toEqual({
      ok: true,
      state: "quarantined",
    });
  });

  it("leaves blocked only via explicit retry (restart lifecycle) or explicit deactivation (RFC §3 blocked 出边规则)", () => {
    expect(transition("blocked", "retry_from_blocked")).toEqual({ ok: true, state: "discovered" });
    expect(transition("blocked", "deactivate_from_blocked")).toEqual({
      ok: true,
      state: "disposing",
    });
    expect(transition("blocked", "activate")).toEqual({
      ok: false,
      from: "blocked",
      event: "activate",
    });
    expect(transition("blocked", "validate")).toEqual({
      ok: false,
      from: "blocked",
      event: "validate",
    });
  });

  it("quarantined: explicit cleanup retry is the only exit; repeated dispose is an idempotent no-op edge (RFC §3 quarantined 规则)", () => {
    expect(transition("quarantined", "retry_cleanup_success")).toEqual({
      ok: true,
      state: "disposed",
    });
    expect(transition("quarantined", "retry_cleanup_failure")).toEqual({
      ok: true,
      state: "quarantined",
    });
    expect(transition("quarantined", "dispose_while_quarantined")).toEqual({
      ok: true,
      state: "quarantined",
    });
    expect(transition("quarantined", "activate")).toEqual({
      ok: false,
      from: "quarantined",
      event: "activate",
    });
  });

  it("disposed is terminal: no out-edges exist on the table", () => {
    expect(LIFECYCLE_TRANSITIONS.disposed).toBeUndefined();
    const everyEvent: LifecycleEvent[] = [
      "validate",
      "prepare",
      "activate",
      "begin_dispose",
      "dispose_complete",
      "dispose_incomplete",
      "fail",
      "rollback",
      "retry_from_blocked",
      "deactivate_from_blocked",
      "retry_cleanup_success",
      "retry_cleanup_failure",
      "dispose_while_quarantined",
    ];
    for (const event of everyEvent) {
      expect(transition("disposed", event).ok).toBe(false);
    }
  });
});
