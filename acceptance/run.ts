/**
 * 判卷程序。用法：
 *
 *   npm run acceptance          # 报告模式：打红绿灯，永远退出 0
 *   npm run acceptance:strict   # 里程碑验收模式：真绿不满六盏就退出 1
 *
 * 判卷程序找 src/acceptance-driver.ts 里的 createDriver()。
 * 还没有实现时，六条全部显示「缺驱动」——这不是错误，是里程碑的起点状态。
 *
 * 真灯与桩灯（2026-08-14 #16 裁定 1 的执行机制）：驱动模块可以导出
 * `STUBBED: string[]`，申报哪些方法还是代写的判卷桩。依赖桩方法跑绿的灯
 * 显示 🟡 桩灯，不计入里程碑；只有六盏真绿才算达成、才解锁 H1。
 * 隐瞒申报是伪证，评审在 PR 里查这份名单与 TODO 标记是否一致。
 */
import { checks } from "./checks.ts";
import type { HarnessDriver } from "./driver.ts";

const strict = process.argv.includes("--strict");

interface LoadedDriver {
  driver: HarnessDriver;
  stubbed: Set<string>;
}

async function loadDriver(): Promise<LoadedDriver | null> {
  try {
    const driverPath = "../src/acceptance-driver.ts";
    const mod = await import(driverPath);
    if (typeof mod.createDriver !== "function") {
      console.error("src/acceptance-driver.ts 存在但没有导出 createDriver()");
      process.exit(2);
    }
    const stubbed = new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []);
    return { driver: mod.createDriver() as HarnessDriver, stubbed };
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) return null;
    if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

const loaded = await loadDriver();
let realGreen = 0;
let stubGreen = 0;

console.log("mist 第一里程碑判卷 —— 最小垂直闭环\n");

for (const check of checks) {
  if (loaded === null) {
    console.log(`  🔴 ${check.id} ${check.title}`);
    console.log("       缺驱动：src/acceptance-driver.ts 尚未存在\n");
    continue;
  }
  const stubDeps = check.uses.filter((m) => loaded.stubbed.has(m));
  try {
    const result = await check.run(loaded.driver);
    if (result.pass && stubDeps.length === 0) {
      realGreen += 1;
      console.log(`  🟢 ${check.id} ${check.title}`);
      console.log(`       ${result.detail}\n`);
    } else if (result.pass) {
      stubGreen += 1;
      console.log(`  🟡 ${check.id} ${check.title}`);
      console.log(`       桩灯：行为通过，但依赖代写的 ${stubDeps.join(" / ")}，交付后才算真绿\n`);
    } else {
      console.log(`  🔴 ${check.id} ${check.title}`);
      console.log(`       ${result.detail}\n`);
    }
  } catch (err) {
    console.log(`  🔴 ${check.id} ${check.title}`);
    console.log(`       抛异常：${err instanceof Error ? err.message : String(err)}\n`);
  }
}

if (loaded !== null && loaded.stubbed.size > 0) {
  console.log(`（申报在案的判卷桩：${[...loaded.stubbed].join(" / ")}）`);
}
console.log(
  `真绿 ${realGreen}/${checks.length}${stubGreen > 0 ? `，桩灯 ${stubGreen} 盏` : ""}。${
    realGreen === checks.length
      ? "六盏真绿。里程碑判定进入复验——独立复验通过、决策台账落章后才算达成、才解锁 H1。判卷机只报灯色，不宣布胜利。"
      : "还没到。"
  }`,
);

if (strict && realGreen !== checks.length) process.exit(1);
