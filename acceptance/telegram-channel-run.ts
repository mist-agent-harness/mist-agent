/** #185（D26）Telegram 信道判卷。 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { telegramChannelChecks } from "./telegram-channel-checks.ts";
import {
  type TelegramChannelCheck,
  type TelegramChannelDriver,
  cloneTelegramChannelDriverBoundary,
} from "./telegram-channel-driver.ts";

const DRIVER_SPECIFIER = "../src/telegram-channel-acceptance-driver.ts";
const strict = process.argv.includes("--strict");

async function loadDriver(): Promise<{
  driver: TelegramChannelDriver;
  stubbed: Set<string>;
} | null> {
  if (!existsSync(fileURLToPath(new URL(DRIVER_SPECIFIER, import.meta.url)))) return null;
  const mod = await import(DRIVER_SPECIFIER);
  if (typeof mod.createTelegramChannelDriver !== "function") {
    throw new Error(
      "src/telegram-channel-acceptance-driver.ts 存在但没有导出 createTelegramChannelDriver()——这是坏驱动，不是起点状态",
    );
  }
  return {
    driver: cloneTelegramChannelDriverBoundary(
      mod.createTelegramChannelDriver() as TelegramChannelDriver,
    ),
    stubbed: new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []),
  };
}

function usesStub(check: TelegramChannelCheck, stubbed: Set<string>): boolean {
  return check.uses.some((method) => stubbed.has(method));
}

async function main(): Promise<void> {
  const loaded = await loadDriver();
  console.log("Telegram 信道与多住户群聊判卷（D26）");
  console.log(`清单真源：acceptance/telegram-channel.md（${telegramChannelChecks.length} 条）`);
  console.log("");

  if (loaded === null) {
    for (const check of telegramChannelChecks) {
      console.log(`🔴 ${check.id} 缺驱动 —— ${check.title}`);
    }
    console.log("");
    console.log("真绿 0 / 14。功能驱动尚未存在；这是判卷先行的红灯起点。");
    process.exit(strict ? 1 : 0);
  }

  let trueGreen = 0;
  let stubGreen = 0;
  for (const check of telegramChannelChecks) {
    try {
      const result = await check.run(loaded.driver);
      if (result.passed && usesStub(check, loaded.stubbed)) {
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
    `真绿 ${trueGreen} / ${telegramChannelChecks.length}${stubGreen > 0 ? `，桩灯 ${stubGreen}` : ""}`,
  );
  if (strict && trueGreen !== telegramChannelChecks.length) process.exit(1);
}

void main();
