/**
 * #184（D24）判卷程序。
 *
 *   npm run acceptance:host-provider
 *   npm run acceptance:host-provider:strict
 *
 * 缺 `src/host-provider-acceptance-driver.ts` 时十四盏全红，报告模式退出 0，
 * 严格模式退出 1。驱动文件存在但 import/导出损坏时直接抛错。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostProviderChecks } from "./host-provider-checks.ts";
import type { HostProviderCheck, HostProviderDriver } from "./host-provider-driver.ts";

const DRIVER_SPECIFIER = "../src/host-provider-acceptance-driver.ts";
const strict = process.argv.includes("--strict");

interface LoadedDriver {
  driver: HostProviderDriver;
  stubbed: Set<string>;
}

function driverFileExists(): boolean {
  return existsSync(fileURLToPath(new URL(DRIVER_SPECIFIER, import.meta.url)));
}

async function loadDriver(): Promise<LoadedDriver | null> {
  if (!driverFileExists()) return null;
  const mod = await import(DRIVER_SPECIFIER);
  if (typeof mod.createHostProviderDriver !== "function") {
    throw new Error(
      "src/host-provider-acceptance-driver.ts 存在但没有导出 createHostProviderDriver()——这是坏驱动，不是起点状态",
    );
  }
  return {
    driver: mod.createHostProviderDriver() as HostProviderDriver,
    stubbed: new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []),
  };
}

function usesStub(check: HostProviderCheck, stubbed: Set<string>): boolean {
  return check.uses.some((method) => stubbed.has(method));
}

async function main(): Promise<void> {
  const loaded = await loadDriver();
  console.log("HostProvider 契约与用户控制权判卷（D24）");
  console.log(`清单真源：acceptance/host-provider.md（${hostProviderChecks.length} 条）`);
  console.log("");

  if (loaded === null) {
    for (const check of hostProviderChecks) {
      console.log(`🔴 ${check.id} 缺驱动 —— ${check.title}`);
    }
    console.log("");
    console.log("真绿 0 / 14。功能驱动尚未存在；这是判卷先行的红灯起点。");
    process.exit(strict ? 1 : 0);
  }

  let trueGreen = 0;
  let stubGreen = 0;
  for (const check of hostProviderChecks) {
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
    `真绿 ${trueGreen} / ${hostProviderChecks.length}${stubGreen > 0 ? `，桩灯 ${stubGreen}` : ""}`,
  );
  if (strict && trueGreen !== hostProviderChecks.length) process.exit(1);
}

void main();
