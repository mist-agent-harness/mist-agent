/**
 * 有意隔离 v0 · 线 2 的判卷程序。用法：
 *
 *   npm run acceptance:isolation           # 报告模式：打红绿灯，永远退出 0
 *   npm run acceptance:isolation:strict    # 验收模式：有一盏不真绿就退出 1
 *
 * 找 `src/isolation-acceptance-driver.ts` 里的 `createIsolationDriver()`。
 * 还没有实现时全部显示「缺驱动」——**那是起点状态，不是故障**，
 * 报告模式照常退出 0。
 *
 * 真灯与桩灯：驱动模块可以导出 `STUBBED: string[]` 申报哪些方法还是判卷桩。
 * 依赖桩方法跑绿的灯显示 🟡，不计入完成；只有真绿才算数。隐瞒申报是伪证。
 *
 * 本程序**不勾** `acceptance/intentional-isolation-v0.md` 里的方框。
 * 方框由独立验收席按 PR 证据勾，判卷程序只报灯色。
 */
import { isolationChecks } from "./isolation-checks.ts";
import type { IsolationCheck, IsolationDriver } from "./isolation-driver.ts";

const strict = process.argv.includes("--strict");

interface LoadedDriver {
  driver: IsolationDriver;
  stubbed: Set<string>;
}

async function loadDriver(): Promise<LoadedDriver | null> {
  try {
    // 走变量而不是字面量：驱动尚未存在时 tsc 不该因为解析不到模块而报错，
    // 「还没实现」是本线的起点状态。同 acceptance/run.ts 的写法。
    const driverPath = "../src/isolation-acceptance-driver.ts";
    const mod = await import(driverPath);
    if (typeof mod.createIsolationDriver !== "function") {
      console.error("src/isolation-acceptance-driver.ts 存在但没有导出 createIsolationDriver()");
      return null;
    }
    const stubbed = new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []);
    return { driver: mod.createIsolationDriver() as IsolationDriver, stubbed };
  } catch (err) {
    // 只把「模块不存在」当起点状态。驱动存在但 import 即抛的话必须炸出来，
    // 否则坏驱动会显示成「还没开工」——假起点和假绿一样是读数造假。同 acceptance/run.ts。
    if (err instanceof Error && err.message.includes("Cannot find module")) return null;
    if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}

function usesStub(check: IsolationCheck, stubbed: Set<string>): boolean {
  return check.uses.some((m) => stubbed.has(m));
}

async function main(): Promise<void> {
  const loaded = await loadDriver();

  console.log("有意隔离 v0 · 线 2（膜）判卷");
  console.log(
    `清单真源：acceptance/intentional-isolation-v0.md（本批 ${isolationChecks.length} 条）`,
  );
  console.log("");

  if (loaded === null) {
    for (const check of isolationChecks) {
      console.log(`⬜ ${check.id} 缺驱动 —— ${check.title}`);
    }
    console.log("");
    console.log("src/isolation-acceptance-driver.ts 还不存在。这是本线的起点状态，不是故障。");
    process.exit(strict ? 1 : 0);
  }

  let trueGreen = 0;
  for (const check of isolationChecks) {
    const stub = usesStub(check, loaded.stubbed);
    try {
      const result = await check.run(loaded.driver);
      if (result.passed && stub) {
        console.log(`🟡 ${check.id} 桩灯 —— ${check.title}`);
        console.log(`     ${result.detail}`);
      } else if (result.passed) {
        trueGreen += 1;
        console.log(`🟢 ${check.id} —— ${check.title}`);
        console.log(`     ${result.detail}`);
      } else {
        console.log(`🔴 ${check.id} —— ${check.title}`);
        console.log(`     ${result.detail}`);
      }
    } catch (error) {
      console.log(`🔴 ${check.id} 抛错 —— ${check.title}`);
      console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("");
  console.log(`真绿 ${trueGreen} / ${isolationChecks.length}`);
  if (strict && trueGreen !== isolationChecks.length) process.exit(1);
}

void main();
