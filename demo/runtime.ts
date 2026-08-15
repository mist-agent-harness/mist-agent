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
import type { BootPack, HarnessDriver } from "../acceptance/driver.ts";
import { type CreateDriverOptions, createDriver } from "../src/acceptance-driver.ts";
import { DEMO_SEED, type DemoSeed, assertDemoSeed, seedDemoResident } from "./seed.ts";
import type { DemoResident, DemoRuntime } from "./server.ts";

const STATE_SCHEMA_VERSION = 2;
const STATE_FILE = "demo-state.json";
const RESIDENTS_DIR = "residents";

export interface PersistentDemoRuntimeOptions {
  /** Dedicated demo directory. It must not be shared with another Mist process. */
  dataDir: string;
  reply?: CreateDriverOptions["reply"];
  seed?: DemoSeed;
}

export interface PersistentDemoInspection extends DemoResident {
  driver: HarnessDriver;
}

export interface PersistentDemoRuntime extends DemoRuntime {
  inspect(): PersistentDemoInspection;
  bootPack(): Promise<BootPack>;
}

interface DemoState {
  schemaVersion: number;
  seedId: string;
  residentId: string;
}

function statePath(dataDir: string): string {
  return join(dataDir, STATE_FILE);
}

function residentDataDir(dataDir: string): string {
  return join(dataDir, RESIDENTS_DIR);
}

function parseState(path: string): DemoState {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("demo state must be an object");
  }
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  if (keys.join(",") !== "residentId,schemaVersion,seedId") {
    throw new Error("demo state has unknown or missing fields");
  }
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported demo state schema: ${String(state.schemaVersion)}`);
  }
  if (typeof state.residentId !== "string" || !/^resident-[a-z0-9]+$/.test(state.residentId)) {
    throw new Error("demo state has an invalid residentId");
  }
  if (typeof state.seedId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(state.seedId)) {
    throw new Error("demo state has an invalid seedId");
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    seedId: state.seedId,
    residentId: state.residentId,
  };
}

function persistState(dataDir: string, seedId: string, residentId: string): void {
  const finalPath = statePath(dataDir);
  const temporaryPath = `${finalPath}.tmp`;
  const body = JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, seedId, residentId });
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "w", 0o600);
    writeSync(descriptor, body);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, finalPath);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write/rename failure.
      }
    }
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function openDriver(dataDir: string, reply: CreateDriverOptions["reply"]): HarnessDriver {
  const options: CreateDriverOptions = { dataDir: residentDataDir(dataDir) };
  if (reply !== undefined) options.reply = reply;
  return createDriver(options);
}

function removeOrphanSnapshots(dataDir: string, residentId: string): void {
  const residents = residentDataDir(dataDir);
  for (const file of readdirSync(residents)) {
    if (file.endsWith(".tmp")) {
      rmSync(join(residents, file), { force: true });
      continue;
    }
    if (file.endsWith(".json") && file !== `${residentId}.json`) {
      rmSync(join(residents, file), { force: true });
    }
  }
}

export async function createPersistentDemoRuntime(
  options: PersistentDemoRuntimeOptions,
): Promise<PersistentDemoRuntime> {
  if (options.dataDir.trim().length === 0) throw new Error("dataDir is required");
  const dataDir = resolve(options.dataDir);
  const seed = options.seed ?? DEMO_SEED;
  assertDemoSeed(seed);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(residentDataDir(dataDir), { recursive: true });

  const savedState = existsSync(statePath(dataDir)) ? parseState(statePath(dataDir)) : null;
  if (savedState !== null && savedState.seedId !== seed.id) {
    throw new Error(
      `demo state belongs to seed ${savedState.seedId}, but this run requested ${seed.id}`,
    );
  }
  let driver = openDriver(dataDir, options.reply);
  let residentId: string;
  if (savedState === null) {
    const existingSnapshots = readdirSync(residentDataDir(dataDir)).filter((file) =>
      file.endsWith(".json"),
    );
    if (existingSnapshots.length > 0) {
      throw new Error("demo resident snapshots exist without demo-state.json");
    }
    residentId = await seedDemoResident(driver, seed);
    persistState(dataDir, seed.id, residentId);
  } else {
    residentId = savedState.residentId;
    await driver.buildBootPack(residentId);
    // Only collect abandoned reset snapshots after the manifest target is
    // proven readable. A bad pointer must fail closed without deleting data.
    removeOrphanSnapshots(dataDir, residentId);
  }

  return {
    current() {
      return { driver, residentId };
    },
    inspect() {
      return { driver, residentId };
    },
    bootPack() {
      return driver.buildBootPack(residentId);
    },
    async reset() {
      const previousDriver = driver;
      const previousResidentId = residentId;
      const nextResidentId = await seedDemoResident(previousDriver, seed);
      persistState(dataDir, seed.id, nextResidentId);
      residentId = nextResidentId;
      await previousDriver.destroyResident(previousResidentId);
      // Re-open from disk so reset exercises the same recovery path as a process restart.
      driver = openDriver(dataDir, options.reply);
      await driver.buildBootPack(residentId);
    },
  };
}
