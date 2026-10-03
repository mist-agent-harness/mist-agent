/**
 * 住户运行时的宿主装配 seam（D28）。
 *
 * 实际 CLI（`cli.ts`）与验收/生产宿主子进程（`host-process.ts`）都经这里构造
 * ResidentRuntime，保证两条真实入口用**同一套**宿主装配：认证权威事实账与住户档案
 * 同在 `residents/` 目录（各认各的后缀），currentFacts 与信里 commitment 档来自
 * `ledger.currentSet()`，`say` 走真实的 prepareDelivery/settlement。
 *
 * 传输可注入是给「录制合成 transport」测试用的（不新增环境变量、不新增生产命令）：
 * 真实入口不传就用 `createModelTransport()` 的现役通道选择。
 *
 * 代价：多一层构造门面，两处入口的差异（如将来 CLI 特有的选项）必须显式落在这里，
 * 不许各自 new。这条纪律换来「CLI 与宿主装配不漂移」。
 */
import { join } from "node:path";
import type { ModelTransport } from "./channels.ts";
import { ResidentRuntime } from "./runtime.ts";

export interface ResidentRuntimeAssemblyOptions {
  readonly dataDir: string;
  /** 缺省按现役通道选择（MIST_RESIDENT_RUNTIME_TRANSPORT）；测试可注入录制传输。 */
  readonly transport?: ModelTransport;
}

/** 构造带认证权威事实账的运行时（全仓 CLI / 宿主子进程的唯一装配门面）。 */
export function assembleResidentRuntime(options: ResidentRuntimeAssemblyOptions): ResidentRuntime {
  return new ResidentRuntime({
    dataDir: options.dataDir,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ledger: { dataDir: join(options.dataDir, "residents") },
  });
}
