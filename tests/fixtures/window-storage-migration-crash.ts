/**
 * #120 存储格式迁移/回滚**中途猝死**的真实夹具（独立验收席 2026-09-24 缺陷二）。
 *
 * 用法：`node --import tsx tests/fixtures/window-storage-migration-crash.ts <dataDir> <mode>`
 *   - `mid-migrate`：走**真实** migrate(v1→v2)，在重写循环写完第一份记录后 `SIGKILL` 自己；
 *   - `mid-rollback`：先真实完成 migrate(v1→v2)，再走**真实** rollback(v1)，在从备份还原
 *     第一份记录后 `SIGKILL` 自己。
 *
 * 它不碰 canonical stream，只跑存储格式管理侧：dataDir 里的窗与事件由父测试先种好。
 * 为什么必须真进程真杀：判卷纪律要求「迁移跑到一半宿主被杀」的证据是真实的
 * （真实目录、真实进程、真实 SIGKILL），一个返回期望对象的 mock 不算证据；而且只有真的
 * 死在循环中间，才能验「重启后这堆版本混杂的记录是否**可识别**为未完成」。
 */
import { WindowStorageFormatAdmin } from "../../src/window-host/index.ts";

const dataDir = process.argv[2];
const mode = process.argv[3];
if (dataDir === undefined || (mode !== "mid-migrate" && mode !== "mid-rollback")) {
  throw new Error("usage: window-storage-migration-crash.ts <dataDir> <mid-migrate|mid-rollback>");
}

function hardKillAfterFirstRecord(expected: "migrate" | "rollback") {
  return (progress: { readonly operation: "migrate" | "rollback"; readonly persisted: number }) => {
    if (progress.operation !== expected || progress.persisted < 1) return;
    // 真实猝死：写完第一份记录、循环还没跑完就硬杀自己。控制账此刻必须已经是 incomplete。
    process.kill(process.pid, "SIGKILL");
  };
}

if (mode === "mid-migrate") {
  const admin = new WindowStorageFormatAdmin(dataDir, {
    onRecordPersisted: hardKillAfterFirstRecord("migrate"),
  });
  admin.migrate(2);
} else {
  // 先干净地迁到 v2（不注入故障），再在回滚的还原循环中间被杀。
  new WindowStorageFormatAdmin(dataDir).migrate(2);
  const admin = new WindowStorageFormatAdmin(dataDir, {
    onRecordPersisted: hardKillAfterFirstRecord("rollback"),
  });
  admin.rollback(1);
}

throw new Error(`fixture reached the end without being killed (mode=${mode})`);
