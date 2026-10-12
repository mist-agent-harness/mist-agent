/**
 * #218（D31）可选网页前端判卷程序。
 *
 *   npm run acceptance:frontend-adapter
 *   npm run acceptance:frontend-adapter:strict
 *
 * 缺 `src/frontend-adapter-acceptance-driver.ts` 时 FE-01～FE-07 全红，报告模式退出 0，
 * 严格模式退出 1。驱动文件存在但 import/导出损坏时直接抛错。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { frontendAdapterChecks } from "./frontend-adapter-checks.ts";
import {
  type FrontendAdapterCheck,
  type FrontendAdapterDriver,
  cloneFrontendAdapterDriverBoundary,
} from "./frontend-adapter-driver.ts";

/**
 * 默认驱动路径；`MIST_FRONTEND_ADAPTER_DRIVER` 只给判卷自己在隔离场景下覆盖
 * （例如把「缺驱动七红」搬到一个不存在的路径上核验），不是产品配置。
 */
const DRIVER_OVERRIDE = process.env.MIST_FRONTEND_ADAPTER_DRIVER;
const DRIVER_SPECIFIER =
  DRIVER_OVERRIDE === undefined || DRIVER_OVERRIDE === ""
    ? "../src/frontend-adapter-acceptance-driver.ts"
    : DRIVER_OVERRIDE;
const strict = process.argv.includes("--strict");

interface LoadedDriver {
  driver: FrontendAdapterDriver;
  stubbed: Set<string>;
}

function driverFileExists(): boolean {
  return existsSync(fileURLToPath(new URL(DRIVER_SPECIFIER, import.meta.url)));
}

async function loadDriver(): Promise<LoadedDriver | null> {
  if (!driverFileExists()) return null;
  const mod = await import(DRIVER_SPECIFIER);
  if (typeof mod.createFrontendAdapterDriver !== "function") {
    throw new Error(
      "src/frontend-adapter-acceptance-driver.ts 存在但没有导出 createFrontendAdapterDriver()——这是坏驱动，不是起点状态",
    );
  }
  return {
    // D27 三：判卷在驱动边界统一深拷贝入参与返回值。
    driver: cloneFrontendAdapterDriverBoundary(
      mod.createFrontendAdapterDriver() as FrontendAdapterDriver,
    ),
    stubbed: new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []),
  };
}

function usesStub(check: FrontendAdapterCheck, stubbed: Set<string>): boolean {
  return check.uses.some((method) => stubbed.has(method));
}

async function main(): Promise<void> {
  const loaded = await loadDriver();
  console.log("可选网页前端与 OpenAI-compatible adapter 判卷（D31）");
  console.log(`清单真源：acceptance/frontend-adapter.md（${frontendAdapterChecks.length} 条）`);
  console.log("");

  if (loaded === null) {
    for (const check of frontendAdapterChecks) {
      console.log(`🔴 ${check.id} 缺驱动 —— ${check.title}`);
    }
    console.log("");
    console.log(
      `真绿 0 / ${frontendAdapterChecks.length}。功能驱动尚未存在；这是判卷先行的红灯起点。`,
    );
    process.exit(strict ? 1 : 0);
  }

  let trueGreen = 0;
  let stubGreen = 0;
  for (const check of frontendAdapterChecks) {
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
    `真绿 ${trueGreen} / ${frontendAdapterChecks.length}${stubGreen > 0 ? `，桩灯 ${stubGreen}` : ""}`,
  );
  if (strict && trueGreen !== frontendAdapterChecks.length) process.exit(1);
}

void main();
