/**
 * 判卷程序。用法：
 *
 *   npm run acceptance          # 报告模式：打红绿灯，永远退出 0
 *   npm run acceptance:strict   # 里程碑验收模式：有一盏不是绿灯就退出 1
 *
 * 判卷程序找 src/acceptance-driver.ts 里的 createDriver()。
 * 还没有实现时，六条全部显示「缺驱动」——这不是错误，是里程碑的起点状态。
 */
import { checks } from "./checks.ts";
import type { HarnessDriver } from "./driver.ts";

const strict = process.argv.includes("--strict");

async function loadDriver(): Promise<HarnessDriver | null> {
  try {
    const driverPath = "../src/acceptance-driver.ts";
    const mod = await import(driverPath);
    if (typeof mod.createDriver !== "function") {
      console.error("src/acceptance-driver.ts 存在但没有导出 createDriver()");
      process.exit(2);
    }
    return mod.createDriver() as HarnessDriver;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) return null;
    if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

const driver = await loadDriver();
let green = 0;

console.log("mist 第一里程碑判卷 —— 最小垂直闭环\n");

for (const check of checks) {
  if (driver === null) {
    console.log(`  🔴 ${check.id} ${check.title}`);
    console.log("       缺驱动：src/acceptance-driver.ts 尚未存在\n");
    continue;
  }
  try {
    const result = await check.run(driver);
    if (result.pass) {
      green += 1;
      console.log(`  🟢 ${check.id} ${check.title}`);
    } else {
      console.log(`  🔴 ${check.id} ${check.title}`);
    }
    console.log(`       ${result.detail}\n`);
  } catch (err) {
    console.log(`  🔴 ${check.id} ${check.title}`);
    console.log(`       抛异常：${err instanceof Error ? err.message : String(err)}\n`);
  }
}

console.log(
  `${green}/${checks.length} 绿。${green === checks.length ? "里程碑达成，H1 解锁。" : "还没到。"}`,
);

if (strict && green !== checks.length) process.exit(1);
