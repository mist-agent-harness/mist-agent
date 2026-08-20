/**
 * PV0-A08 写盘门半场 —— 事务层「普通安装不得覆盖现役」(RFC §2/§8, PR#97 评审①)。
 *
 * pv0-a-manifest.test.ts 的 A08 前半取证 discovery 预检（非法 id + 调用方自报的现役
 * 集合）；本文件取证权威闸：PluginTransactionHost.activate 在落任何权威记录之前
 * 自己读真账——本进程 runtime 与 store 持久 active 记录——拒装，且现役账/runtime/
 * 资源零变动（§8：「blocked，现役插件不变」）。
 *
 * 变异锚：把 activate 里的 install-gate 调用摘掉，「同 id 二次 activate 覆盖现役」
 * 与「重启窗直捅写盘」两腿全红——这正是评审①指出原 A08 无法变红的路径。
 * 直捅 host.activate 在本文件是合法取证姿势：被考的就是写盘入口本身。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moduleRefFromSource } from "../../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../../src/plugin/operation-store.ts";
import { PluginTransactionHost } from "../../src/plugin/transaction-host.ts";
import type { PluginModuleV0 } from "../../src/plugin/types.ts";

let root: string;
let seq = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pv0-a08-gate-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Counters {
  prepared: number;
  resourceDisposed: number;
  pluginDisposed: number;
}

function counters(): Counters {
  return { prepared: 0, resourceDisposed: 0, pluginDisposed: 0 };
}

function moduleWith(c: Counters): PluginModuleV0 {
  return {
    async prepare(context) {
      c.prepared += 1;
      context.register({
        id: "res-1",
        kind: "tool",
        recoveryKey: "rk-1",
        async activate() {},
        async dispose() {
          c.resourceDisposed += 1;
        },
      });
      return {
        async activate() {
          return {
            async dispose() {
              c.pluginDisposed += 1;
              return { revoked: ["res-1"], failed: [] };
            },
          };
        },
        async rollback() {},
      };
    },
  };
}

const authority = {
  config: { enabled: true, settings: { keep: "v1" } },
  bindings: {},
  verifiedScope: {},
} as const;

function request(pluginId: string, module: PluginModuleV0, tag: string) {
  return { pluginId, moduleRef: moduleRefFromSource(tag), module, env: {}, ...authority };
}

describe("PV0-A08 写盘门 — 普通安装不得覆盖现役 (RFC §2/§8)", () => {
  it("同 id 二次 activate：拒装、零写盘、现役账与 runtime 一概不动", async () => {
    const store = new PluginOperationStore(join(root, `store-${seq++}`));
    const host = new PluginTransactionHost({ store, newOperationId: () => `op-${seq++}` });
    const first = counters();
    const firstOutcome = await host.activate(request("demo.gate", moduleWith(first), "gate-v1"));
    expect(firstOutcome.state).toBe("active");
    const before = store.read("demo.gate");
    const publishedBefore = host.publishedResources("demo.gate");
    expect(publishedBefore).toHaveLength(1);

    const intruder = counters();
    const refused = await host.activate(request("demo.gate", moduleWith(intruder), "gate-v2"));
    expect(refused).toEqual({
      pluginId: "demo.gate",
      state: "blocked",
      reasonCode: "PLUGIN_ID_CONFLICT",
      detail: expect.stringContaining("normal install must not overwrite"),
    });
    expect("operationId" in refused).toBe(false); // 被拒的企图不产生事务账

    // 现役插件不变：权威记录逐字节等值（同 operationId、同 config、仍 active）
    const after = store.read("demo.gate");
    expect(after).toEqual(before);
    expect(after.operation.operationId).toBe(before.operation.operationId);
    // 旧 runtime 未被顶替：资源仍可枚举、未被 dispose；入侵模块 prepare 从未运行
    expect(host.publishedResources("demo.gate")).toEqual(publishedBefore);
    expect(first.resourceDisposed).toBe(0);
    expect(first.pluginDisposed).toBe(0);
    expect(intruder.prepared).toBe(0);
  });

  it("重启窗（store 有 active 账、recovery 未接管）：写盘入口同样拒装", async () => {
    const dir = join(root, `store-${seq++}`);
    const store = new PluginOperationStore(dir);
    const host = new PluginTransactionHost({ store, newOperationId: () => `op-${seq++}` });
    const first = counters();
    await host.activate(request("demo.restart", moduleWith(first), "restart-v1"));
    const before = new PluginOperationStore(dir).read("demo.restart");

    // 新进程视角：#active 为空，现役事实只剩权威 store——评审①点名的缺口。
    const rebooted = new PluginTransactionHost({
      store: new PluginOperationStore(dir),
      newOperationId: () => `op-${seq++}`,
    });
    const intruder = counters();
    const refused = await rebooted.activate(
      request("demo.restart", moduleWith(intruder), "restart-v2"),
    );
    expect(refused).toMatchObject({ state: "blocked", reasonCode: "PLUGIN_ID_CONFLICT" });
    expect(intruder.prepared).toBe(0);
    expect(new PluginOperationStore(dir).read("demo.restart")).toEqual(before);
  });

  it("门不误伤：blocked 显式重试与 disposed 重装照走完整事务", async () => {
    const store = new PluginOperationStore(join(root, `store-${seq++}`));
    const host = new PluginTransactionHost({ store, newOperationId: () => `op-${seq++}` });

    // blocked → 重试：prepare 失败落 blocked（非现役），修好后同 id 重进事务合法。
    const failing: PluginModuleV0 = {
      async prepare() {
        throw new Error("prepare failed on purpose");
      },
    };
    const blockedOutcome = await host.activate(request("demo.retry", failing, "retry-v1"));
    expect(blockedOutcome).toMatchObject({ state: "blocked", reasonCode: "PREPARE_FAILED" });
    const retry = counters();
    const retried = await host.activate(request("demo.retry", moduleWith(retry), "retry-v2"));
    expect(retried.state).toBe("active");
    expect(retry.prepared).toBe(1);

    // active → disposed → 重装：旧账已非现役，新事务（新 operationId）合法进门。
    const life = counters();
    const on = await host.activate(request("demo.reinstall", moduleWith(life), "re-v1"));
    expect(on.state).toBe("active");
    const off = await host.dispose("demo.reinstall");
    expect(off.state).toBe("disposed");
    const again = await host.activate(request("demo.reinstall", moduleWith(life), "re-v2"));
    expect(again.state).toBe("active");
    if (!("operationId" in on) || !("operationId" in again)) {
      throw new Error("full transactions must carry operation ids");
    }
    expect(again.operationId).not.toBe(on.operationId);
  });
});
