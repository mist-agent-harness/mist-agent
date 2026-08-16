import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { BootPack, HarnessDriver } from "../acceptance/driver.ts";
import { type CreateDriverOptions, createDriver } from "../src/acceptance-driver.ts";
import { DEMO_SEED, type DemoSeed, assertDemoSeed, seedDemoResident } from "./seed.ts";
import type { DemoResident, DemoRuntime } from "./server.ts";

const STATE_SCHEMA_VERSION = 2;
const STATE_FILE = "demo-state.json";
const LOCK_FILE = "demo.lock";
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
  close(): void;
}

interface DemoState {
  schemaVersion: number;
  seedId: string;
  residentId: string;
}

interface DataDirLockRecord {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

interface DataDirLock {
  assertHeld(): void;
  release(): void;
}

export class DemoDataDirLockedError extends Error {
  constructor(dataDir: string, owner: DataDirLockRecord | null) {
    const description =
      owner === null
        ? `an unknown process (owner metadata in ${join(dataDir, LOCK_FILE)} is unreadable)`
        : `pid ${owner.pid} on ${owner.hostname}, started ${owner.startedAt}`;
    super(`demo data directory is locked by ${description}: ${dataDir}`);
    this.name = "DemoDataDirLockedError";
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function parseLockRecord(value: string): DataDirLockRecord | null {
  try {
    const record = JSON.parse(value) as Partial<DataDirLockRecord>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.token !== "string" ||
      record.token.length === 0 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid ?? 0) <= 0 ||
      typeof record.hostname !== "string" ||
      record.hostname.length === 0 ||
      typeof record.startedAt !== "string" ||
      !Number.isFinite(Date.parse(record.startedAt))
    ) {
      return null;
    }
    return record as DataDirLockRecord;
  } catch {
    return null;
  }
}

function lockOwnerIsGone(record: DataDirLockRecord): boolean {
  if (record.hostname !== hostname()) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return hasErrorCode(error, "ESRCH");
  }
}

function acquireDataDirLock(dataDir: string): DataDirLock {
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: DataDirLockRecord = {
      schemaVersion: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    };
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;

      let owner: DataDirLockRecord | null;
      try {
        owner = parseLockRecord(readFileSync(path, "utf8"));
      } catch (readError) {
        if (hasErrorCode(readError, "ENOENT")) continue;
        owner = null;
      }
      if (owner !== null && lockOwnerIsGone(owner)) {
        try {
          rmSync(path);
        } catch (removeError) {
          if (hasErrorCode(removeError, "ENOENT")) continue;
          throw removeError;
        }
        continue;
      }
      throw new DemoDataDirLockedError(dataDir, owner);
    }

    try {
      fchmodSync(descriptor, 0o600);
      writeSync(descriptor, JSON.stringify(record));
      fsyncSync(descriptor);
    } catch (error) {
      try {
        closeSync(descriptor);
      } finally {
        rmSync(path, { force: true });
      }
      throw error;
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.off("exit", release);
      try {
        closeSync(descriptor);
      } catch {
        // The lock file identity check below still prevents deleting another owner's lock.
      }
      try {
        const current = parseLockRecord(readFileSync(path, "utf8"));
        if (current?.token === record.token) rmSync(path, { force: true });
      } catch {
        // Process shutdown and explicit close are both idempotent.
      }
    };
    const lock: DataDirLock = {
      assertHeld() {
        if (released) throw new Error(`demo data directory lock has been released: ${dataDir}`);
        let current: DataDirLockRecord | null = null;
        try {
          current = parseLockRecord(readFileSync(path, "utf8"));
        } catch {
          // Report the same explicit lost-lock error for deletion and unreadable metadata.
        }
        if (current?.token !== record.token) {
          throw new Error(`demo data directory lock was lost: ${dataDir}`);
        }
      },
      release,
    };
    process.once("exit", release);
    return lock;
  }
  throw new DemoDataDirLockedError(dataDir, null);
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

function persistState(
  lock: DataDirLock,
  dataDir: string,
  seedId: string,
  residentId: string,
): void {
  lock.assertHeld();
  const finalPath = statePath(dataDir);
  const temporaryPath = `${finalPath}.tmp`;
  const body = JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, seedId, residentId });
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "w", 0o600);
    fchmodSync(descriptor, 0o600);
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

function removeOrphanSnapshots(lock: DataDirLock, dataDir: string, residentId: string): void {
  lock.assertHeld();
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
  const lock = acquireDataDirLock(dataDir);
  try {
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
      persistState(lock, dataDir, seed.id, residentId);
    } else {
      residentId = savedState.residentId;
      await driver.buildBootPack(residentId);
      // Only collect abandoned reset snapshots after the manifest target is
      // proven readable. A bad pointer must fail closed without deleting data.
      removeOrphanSnapshots(lock, dataDir, residentId);
    }

    return {
      current() {
        lock.assertHeld();
        return { driver, residentId };
      },
      inspect() {
        lock.assertHeld();
        return { driver, residentId };
      },
      bootPack() {
        lock.assertHeld();
        return driver.buildBootPack(residentId);
      },
      async reset() {
        lock.assertHeld();
        const previousDriver = driver;
        const previousResidentId = residentId;
        const nextResidentId = await seedDemoResident(previousDriver, seed);
        lock.assertHeld();
        persistState(lock, dataDir, seed.id, nextResidentId);
        residentId = nextResidentId;
        await previousDriver.destroyResident(previousResidentId);
        lock.assertHeld();
        // Re-open from disk so reset exercises the same recovery path as a process restart.
        driver = openDriver(dataDir, options.reply);
        await driver.buildBootPack(residentId);
        lock.assertHeld();
      },
      close() {
        lock.release();
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}
