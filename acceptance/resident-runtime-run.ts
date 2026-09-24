/**
 * #194（RT-01～RT-07）判卷程序。
 *
 *   npm run acceptance:resident-runtime
 *   npm run acceptance:resident-runtime:strict
 *
 * 缺 `src/resident-runtime-acceptance-driver.ts` 时七盏全红，报告模式退出 0，
 * 严格模式退出 1。驱动文件存在但 import/导出损坏时直接抛错，不能伪装成起点状态。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { residentRuntimeChecks } from "./resident-runtime-checks.ts";
import {
  type ResidentRuntimeCheck,
  type ResidentRuntimeDriver,
  cloneResidentRuntimeDriverBoundary,
} from "./resident-runtime-driver.ts";

const DRIVER_SPECIFIER = "../src/resident-runtime-acceptance-driver.ts";
const strict = process.argv.includes("--strict");

interface LoadedDriver {
  readonly driver: ResidentRuntimeDriver;
  readonly stubbed: Set<string>;
}

function driverFileExists(): boolean {
  return existsSync(fileURLToPath(new URL(DRIVER_SPECIFIER, import.meta.url)));
}

async function loadDriver(): Promise<LoadedDriver | null> {
  if (!driverFileExists()) return null;
  const mod = await import(DRIVER_SPECIFIER);
  if (typeof mod.createResidentRuntimeDriver !== "function") {
    throw new Error(
      "src/resident-runtime-acceptance-driver.ts 存在但没有导出 createResidentRuntimeDriver()——这是坏驱动，不是起点状态",
    );
  }
  const stubbed = new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []);
  return {
    driver: cloneResidentRuntimeDriverBoundary(
      mod.createResidentRuntimeDriver() as ResidentRuntimeDriver,
    ),
    stubbed,
  };
}

function usesStub(check: ResidentRuntimeCheck, stubbed: Set<string>): boolean {
  return check.uses.some((method) => stubbed.has(method));
}

async function main(): Promise<void> {
  const loaded = await loadDriver();
  console.log("住户运行时与终端入口判卷（#194 / D28）");
  console.log(`清单真源：acceptance/resident-runtime.md（${residentRuntimeChecks.length} 条）`);
  console.log("");

  if (loaded === null) {
    for (const check of residentRuntimeChecks) {
      console.log(`🔴 ${check.id} 缺驱动 —— ${check.title}`);
    }
    console.log("");
    console.log(
      `真绿 0 / ${residentRuntimeChecks.length}。功能驱动尚未存在；这是判卷先行的红灯起点。`,
    );
    process.exit(strict ? 1 : 0);
  }

  let trueGreen = 0;
  let stubGreen = 0;
  for (const check of residentRuntimeChecks) {
    const stub = usesStub(check, loaded.stubbed);
    try {
      // 每盏灯前清干净（契约：「每盏灯后清掉合成住户、通道、落盘目录与注入的故障」）。
      // 灯与灯之间不许共享住户状态——否则上一盏留下的流 / 凭证 / 故障会把下一盏判红，
      // 那是判卷自己造的假红，不是被测实现的毛病。
      await loaded.driver.reset();
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
    `真绿 ${trueGreen} / ${residentRuntimeChecks.length}${stubGreen > 0 ? `，桩灯 ${stubGreen}` : ""}`,
  );
  if (strict && trueGreen !== residentRuntimeChecks.length) process.exit(1);
}

void main();
