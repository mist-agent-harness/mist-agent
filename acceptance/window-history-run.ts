/**
 * #120（WH-01～WH-06）判卷程序。
 *
 *   npm run acceptance:window-history
 *   npm run acceptance:window-history:strict
 *
 * 缺 `src/window-history-acceptance-driver.ts` 时六盏全红，报告模式退出 0，
 * 严格模式退出 1。驱动文件存在但 import/导出损坏时直接抛错，不能伪装成起点状态。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { windowHistoryChecks } from "./window-history-checks.ts";
import {
  type WindowHistoryCheck,
  type WindowHistoryDriver,
  cloneWindowHistoryDriverBoundary,
} from "./window-history-driver.ts";

const DRIVER_SPECIFIER = "../src/window-history-acceptance-driver.ts";
const strict = process.argv.includes("--strict");

interface LoadedDriver {
  readonly driver: WindowHistoryDriver;
  readonly stubbed: Set<string>;
}

function driverFileExists(): boolean {
  return existsSync(fileURLToPath(new URL(DRIVER_SPECIFIER, import.meta.url)));
}

async function loadDriver(): Promise<LoadedDriver | null> {
  if (!driverFileExists()) return null;
  const driverPath = DRIVER_SPECIFIER;
  const mod = await import(driverPath);
  if (typeof mod.createWindowHistoryDriver !== "function") {
    throw new Error(
      "src/window-history-acceptance-driver.ts 存在但没有导出 createWindowHistoryDriver()——这是坏驱动，不是起点状态",
    );
  }
  const stubbed = new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []);
  return {
    driver: cloneWindowHistoryDriverBoundary(
      mod.createWindowHistoryDriver() as WindowHistoryDriver,
    ),
    stubbed,
  };
}

function usesStub(check: WindowHistoryCheck, stubbed: Set<string>): boolean {
  return check.uses.some((method) => stubbed.has(method));
}

async function main(): Promise<void> {
  const loaded = await loadDriver();
  console.log("生产 MistWindowHistoryPort 持久化判卷（#120）");
  console.log(`清单真源：acceptance/window-history.md（${windowHistoryChecks.length} 条）`);
  console.log("");

  if (loaded === null) {
    for (const check of windowHistoryChecks) {
      console.log(`🔴 ${check.id} 缺驱动 —— ${check.title}`);
    }
    console.log("");
    console.log(
      `真绿 0 / ${windowHistoryChecks.length}。功能驱动尚未存在；这是判卷先行的红灯起点。`,
    );
    process.exit(strict ? 1 : 0);
  }

  let trueGreen = 0;
  let stubGreen = 0;
  for (const check of windowHistoryChecks) {
    const stub = usesStub(check, loaded.stubbed);
    try {
      const result = await check.run(loaded.driver);
      if (result.passed && stub) {
        stubGreen += 1;
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
  console.log(
    `真绿 ${trueGreen} / ${windowHistoryChecks.length}${stubGreen > 0 ? `，桩灯 ${stubGreen}` : ""}`,
  );
  if (strict && trueGreen !== windowHistoryChecks.length) process.exit(1);
}

void main();
