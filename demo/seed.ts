/**
 * 毛坯房 demo 的编造住户种子。
 *
 * 仓库只带一套虚构材料。真实人格、真实记忆和聊天记录永远不进这里。
 * dataDir 只存住户快照；种子清单放在它的上一级，避免被 ResidentStore 当成住户读取。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessDriver } from "../acceptance/driver.ts";
import { type CreateDriverOptions, createDriver } from "../src/acceptance-driver.ts";

export const DEMO_SEED_ID = "mist-rough-house-v1";
export const DEMO_RESIDENT_NAME = "雾灯（虚构演示住户）";
export const DEMO_MEMORIES = [
  "我的朋友希望我称呼她为小栖。",
  "我和小栖曾在虚构的雾港图书馆一起修好一盏纸灯。",
] as const;
export const DEMO_COMMITMENTS = ["我答应每次重新醒来，都先问小栖是否平安到家。"] as const;

const SEED_SCHEMA_VERSION = 1;
const DEFAULT_DATA_ROOT = ".mist-demo";
const RESIDENT_FILE = /^(resident-[a-z0-9-]+)\.json$/;

interface SeedManifest {
  schemaVersion: typeof SEED_SCHEMA_VERSION;
  seedId: typeof DEMO_SEED_ID;
  residentId: string;
}

export interface DemoSeedOptions {
  dataRoot?: string;
  reply?: CreateDriverOptions["reply"];
}

export interface DemoSeedResult {
  driver: HarnessDriver;
  residentId: string;
  dataRoot: string;
  created: boolean;
}

export class DemoSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoSeedError";
  }
}

function manifestFrom(value: unknown): SeedManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DemoSeedError("demo seed manifest 必须是 JSON object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "residentId,schemaVersion,seedId" ||
    record.schemaVersion !== SEED_SCHEMA_VERSION ||
    record.seedId !== DEMO_SEED_ID ||
    typeof record.residentId !== "string" ||
    !/^resident-[a-z0-9-]+$/.test(record.residentId)
  ) {
    throw new DemoSeedError("demo seed manifest 形状或版本不受支持，拒绝猜测修复");
  }
  return record as unknown as SeedManifest;
}

function readManifest(path: string): SeedManifest | null {
  if (!existsSync(path)) return null;
  try {
    return manifestFrom(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof DemoSeedError) throw error;
    throw new DemoSeedError(`demo seed manifest 无法读取: ${String(error)}`);
  }
}

function residentIds(dataDir: string): string[] {
  return readdirSync(dataDir)
    .map((file) => RESIDENT_FILE.exec(file)?.[1])
    .filter((residentId): residentId is string => residentId !== undefined)
    .sort();
}

function writeManifest(path: string, manifest: SeedManifest): void {
  const tmpPath = `${path}.${process.pid}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 保留原始错误。
      }
    }
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

async function completeSeed(driver: HarnessDriver, residentId: string): Promise<void> {
  const before = await driver.buildBootPack(residentId);
  if (before.identity !== DEMO_RESIDENT_NAME) {
    throw new DemoSeedError(`demo data dir 已属于另一位住户: ${residentId} (${before.identity})`);
  }

  const memoryContents = before.memories.map((memory) => memory.content);
  for (const content of DEMO_MEMORIES) {
    const count = memoryContents.filter((stored) => stored === content).length;
    if (count > 1) {
      throw new DemoSeedError(`demo memory 已重复 ${count} 次，拒绝继续扩大重复: ${content}`);
    }
    if (count === 0) {
      await driver.remember(residentId, content);
      memoryContents.push(content);
    }
  }

  const commitments = [...before.commitments];
  for (const content of DEMO_COMMITMENTS) {
    const count = commitments.filter((stored) => stored === content).length;
    if (count > 1) {
      throw new DemoSeedError(`demo commitment 已重复 ${count} 次，拒绝继续扩大重复: ${content}`);
    }
    if (count === 0) {
      await driver.commit(residentId, content);
      commitments.push(content);
    }
  }
}

/**
 * 建立或恢复同一位虚构住户。
 *
 * 锁文件让两个并发启动不能各建一位；进程若在播种中途死亡，锁会留下并显式挡住
 * 下一次启动，避免自动猜测一个可能已经损坏的现场。人工确认后删除锁即可重试，
 * 已写入的精确种子项会被识别并只补缺项。
 */
export async function seedDemoResident(options: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  const dataRoot = resolve(options.dataRoot ?? process.env.MIST_DEMO_DATA_DIR ?? DEFAULT_DATA_ROOT);
  const dataDir = join(dataRoot, "residents");
  const manifestPath = join(dataRoot, "seed-manifest.json");
  const lockPath = join(dataRoot, "seed.lock");
  mkdirSync(dataDir, { recursive: true });

  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new DemoSeedError(`demo seed 已被另一进程占用或上次异常退出: ${String(error)}`);
  }

  try {
    const driverOptions: CreateDriverOptions = { dataDir };
    if (options.reply !== undefined) driverOptions.reply = options.reply;
    const driver = createDriver(driverOptions);
    const manifest = readManifest(manifestPath);
    const storedResidents = residentIds(dataDir);

    let residentId: string;
    let created = false;
    if (manifest !== null) {
      if (!storedResidents.includes(manifest.residentId)) {
        throw new DemoSeedError(`demo seed manifest 指向不存在的住户快照: ${manifest.residentId}`);
      }
      residentId = manifest.residentId;
    } else if (storedResidents.length === 0) {
      residentId = await driver.createResident(DEMO_RESIDENT_NAME);
      created = true;
    } else if (storedResidents.length === 1) {
      // 恢复「住户已写入、manifest 尚未来得及落盘」的中断现场。
      residentId = storedResidents[0] as string;
    } else {
      throw new DemoSeedError(
        `demo seed manifest 缺失，但目录里有 ${storedResidents.length} 位住户，拒绝猜哪位是演示住户`,
      );
    }

    await completeSeed(driver, residentId);
    if (manifest === null) {
      writeManifest(manifestPath, {
        schemaVersion: SEED_SCHEMA_VERSION,
        seedId: DEMO_SEED_ID,
        residentId,
      });
    }
    return { driver, residentId, dataRoot, created };
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

async function main(): Promise<void> {
  const result = await seedDemoResident();
  const action = result.created ? "seeded" : "ready";
  process.stdout.write(`demo resident ${action}: ${result.residentId}\ndata: ${result.dataRoot}\n`);
}

const invokedPath =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
