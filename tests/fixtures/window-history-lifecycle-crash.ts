/**
 * #120 窗生命周期耐久性的**真实猝死夹具**（独立验收席 2026-09-24 复现脚本的仓内等价物）。
 *
 * 用法：`node --import tsx tests/fixtures/window-history-lifecycle-crash.ts <dataDir> <reportPath>`
 *
 * 它在一个**真实子进程**里对**真实目录**做一遍窗生命周期动作（开窗 / 写当代 / 换气 /
 * 旧代迟到写 / 开第二扇窗 / 归档 / 归档后同代写 / summarize），把同进程内观察到的结果写
 * 到 reportPath，然后 `SIGKILL` 自己——**不 close、不优雅退出**，内存态一律丢光。
 * 父测试随后在同一个 dataDir 上拉起新宿主：能读回来的只有真正落盘的事实。
 *
 * 为什么要真进程：换气/归档若只活在内存里，同进程断言全绿也证明不了任何耐久性；
 * 必须让进程真的死掉，才能把「重启后旧代迟到写被接受」这类洞照出来。
 */
import { writeFileSync } from "node:fs";
import { WindowHistoryHost } from "../../src/window-host/index.ts";

const dataDir = process.argv[2];
const reportPath = process.argv[3];
if (dataDir === undefined || reportPath === undefined) {
  throw new Error("usage: window-history-lifecycle-crash.ts <dataDir> <reportPath>");
}

const residentId = "res-a";
const host = new WindowHistoryHost({ dataDir });
const report: Record<string, string | number | boolean> = { pid: process.pid };

const opened = await host.openWindow({ residentId, windowId: "win-1" });
report.openWin1 = opened.ok;

const firstWrite = await host.appendWindowEvent({
  residentId,
  windowId: "win-1",
  generation: 1,
  idempotencyKey: "win-1-gen1",
  payload: { mark: "hi" },
});
report.gen1Write = firstWrite.ok;

const rotated = await host.rotateGeneration({ residentId, windowId: "win-1" });
report.rotatedTo = rotated.ok ? rotated.value.generation : `error:${rotated.error.code}`;

const lateSameProcess = await host.appendWindowEvent({
  residentId,
  windowId: "win-1",
  generation: 1,
  idempotencyKey: "win-1-late",
  payload: { mark: "late" },
});
report.lateWriteSameProcess = lateSameProcess.ok ? "ACCEPTED" : lateSameProcess.error.code;

await host.openWindow({ residentId, windowId: "win-2" });
const archived = await host.archiveWindow({ residentId, windowId: "win-2" });
report.win2Archived = archived.ok ? archived.value.archived : `error:${archived.error.code}`;

const archivedWrite = await host.appendWindowEvent({
  residentId,
  windowId: "win-2",
  generation: 1,
  idempotencyKey: "win-2-after-archive",
  payload: { mark: "after-archive" },
});
report.archivedWriteSameProcess = archivedWrite.ok ? "ACCEPTED" : archivedWrite.error.code;

const summary = await host.summarize({ residentId, windowId: "win-2", generation: null });
report.win2RunningSameProcess = summary.ok ? summary.value.running : `error:${summary.error.code}`;

writeFileSync(reportPath, JSON.stringify(report), "utf8");
// 真实猝死：不 close、不 flush，直接硬杀自己。盘上留下的就是全部事实。
process.kill(process.pid, "SIGKILL");
