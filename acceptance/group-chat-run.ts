/**
 * #191 PR1: executable contract for GC-01..05, GC-09 and GC-15.
 *
 *   npm run acceptance:group-chat        # report expected reds if no host adapter
 *   npm run acceptance:group-chat:strict # nonzero unless all real-host checks pass
 *
 * A missing adapter is a known red baseline, never a green or host test result.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groupChatChecks, runGroupChatCheck } from "./group-chat-checks.ts";
import {
  type GroupChatCheckId,
  type GroupChatHostDriver,
  cloneGroupChatDriverBoundary,
  groupChatSyntheticFixture,
} from "./group-chat-driver.ts";

const DRIVER_SPECIFIER = "../src/group-chat-acceptance-driver.ts";
const strict = process.argv.includes("--strict");

export interface GroupChatRunResult {
  readonly id: GroupChatCheckId;
  readonly title: string;
  readonly passed: boolean;
  readonly stubbed: boolean;
  readonly detail: string;
}

export function scoreGroupChatResults(results: readonly GroupChatRunResult[]): {
  readonly trueGreen: number;
  readonly stubGreen: number;
  readonly strictPass: boolean;
} {
  const trueGreen = results.filter((result) => result.passed && !result.stubbed).length;
  const stubGreen = results.filter((result) => result.passed && result.stubbed).length;
  return { trueGreen, stubGreen, strictPass: trueGreen === results.length };
}

export function missingDriverResults(): GroupChatRunResult[] {
  return groupChatChecks.map(({ id, title }) => ({
    id,
    title,
    passed: false,
    stubbed: false,
    detail: "real-host driver missing (expected PR1 red; no host behavior exercised)",
  }));
}

function driverFileExists(): boolean {
  return existsSync(fileURLToPath(new URL(DRIVER_SPECIFIER, import.meta.url)));
}

interface LoadedDriver {
  readonly driver: GroupChatHostDriver;
  readonly stubbed: ReadonlySet<string>;
}

async function loadDriver(): Promise<LoadedDriver | null> {
  if (!driverFileExists()) return null;
  const mod = await import(DRIVER_SPECIFIER);
  if (typeof mod.createGroupChatHostDriver !== "function") {
    throw new Error(
      "src/group-chat-acceptance-driver.ts exists but does not export createGroupChatHostDriver()",
    );
  }
  const driver = mod.createGroupChatHostDriver() as GroupChatHostDriver;
  if (driver.kind !== "mist-host") {
    throw new Error(
      "group-chat acceptance accepts only the real Mist host adapter; fake drivers are not host evidence",
    );
  }
  return {
    driver: cloneGroupChatDriverBoundary(driver),
    stubbed: new Set<string>(Array.isArray(mod.STUBBED) ? mod.STUBBED : []),
  };
}

async function runHostChecks(loaded: LoadedDriver): Promise<GroupChatRunResult[]> {
  const { driver, stubbed } = loaded;
  const host = await driver.startHost();
  if (!Number.isSafeInteger(host.pid) || host.pid <= 0 || host.commit.trim() === "") {
    await driver.stopHost();
    throw new Error("real-host adapter did not report a valid process id and source commit");
  }

  const results: GroupChatRunResult[] = [];
  try {
    for (const check of groupChatChecks) {
      try {
        const verdict = await runGroupChatCheck(check.id, driver);
        const isStubbed = check.uses.some((method) => stubbed.has(method));
        results.push({
          id: check.id,
          title: check.title,
          ...verdict,
          stubbed: isStubbed,
        });
      } catch (error) {
        results.push({
          id: check.id,
          title: check.title,
          passed: false,
          stubbed: false,
          detail: `scenario threw: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    await driver.stopHost();
  }
  console.log(`真实宿主进程 PID ${host.pid}；代码 ${host.commit}`);
  return results;
}

async function main(): Promise<void> {
  const driver = await loadDriver();
  console.log("Mist #191 群聊验收：GC-01～05、GC-09、GC-15");
  console.log(`合成夹具：${groupChatSyntheticFixture.roomId}；不读取真实聊天/记忆/凭据`);
  console.log("");

  const results = driver === null ? missingDriverResults() : await runHostChecks(driver);
  const score = scoreGroupChatResults(results);
  for (const result of results) {
    console.log(
      `${result.passed ? (result.stubbed ? "🟡" : "🟢") : "🔴"} ${result.id} ${result.stubbed && result.passed ? `桩灯 — ${result.title}` : result.title}`,
    );
    console.log(`   ${result.detail}`);
  }
  console.log("");
  console.log(
    `真实宿主通过 ${driver === null ? 0 : score.trueGreen} / ${results.length}${score.stubGreen > 0 ? `；桩灯 ${score.stubGreen}` : ""}`,
  );
  if (driver === null) console.log("这轮只确认 PR1 的预期红灯；没有执行宿主正向/负向验收。");
  if (strict && !score.strictPass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
