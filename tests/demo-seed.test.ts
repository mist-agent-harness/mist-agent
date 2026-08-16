import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessDriver } from "../acceptance/driver.ts";
import {
  type PersistentDemoRuntime,
  type PersistentDemoRuntimeOptions,
  createPersistentDemoRuntime,
} from "../demo/runtime.ts";
import { DEMO_SEED, DemoSeedError, assertDemoSeed, seedDemoResident } from "../demo/seed.ts";
import { createDriver } from "../src/acceptance-driver.ts";

const dirs: string[] = [];
const runtimes: PersistentDemoRuntime[] = [];

function freshDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-demo-seed-"));
  dirs.push(directory);
  return directory;
}

async function openRuntime(options: PersistentDemoRuntimeOptions): Promise<PersistentDemoRuntime> {
  const runtime = await createPersistentDemoRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("demo seed", () => {
  it("通过 Mist 真接口写入固定的纯虚构身份、记忆和承诺", async () => {
    const driver = createDriver();

    const residentId = await seedDemoResident(driver);
    const bootPack = await driver.buildBootPack(residentId);

    expect(bootPack.identity).toBe(DEMO_SEED.name);
    expect(bootPack.memories.map((memory) => memory.content)).toEqual(DEMO_SEED.memories);
    expect(bootPack.commitments).toEqual(DEMO_SEED.commitments);
  });

  it("runtime 首次启动播种，后续启动复用同一住户且零字节重复写入", async () => {
    const dataDir = freshDir();
    const first = await openRuntime({ dataDir });
    const residentId = first.inspect().residentId;
    const residentPath = join(dataDir, "residents", `${residentId}.json`);
    const statePath = join(dataDir, "demo-state.json");
    const before = {
      resident: readFileSync(residentPath),
      state: readFileSync(statePath),
      files: readdirSync(join(dataDir, "residents")),
    };

    first.close();
    const second = await openRuntime({ dataDir });

    expect(second.inspect().residentId).toBe(residentId);
    expect(readFileSync(residentPath)).toEqual(before.resident);
    expect(readFileSync(statePath)).toEqual(before.state);
    expect(readdirSync(join(dataDir, "residents"))).toEqual(before.files);
    expect(JSON.parse(before.state.toString("utf8"))).toEqual({
      schemaVersion: 2,
      seedId: DEMO_SEED.id,
      residentId,
    });
  });

  it("状态属于另一套 seed 时 fail closed，不换住户也不改字节", async () => {
    const dataDir = freshDir();
    const first = await openRuntime({ dataDir });
    const residentId = first.inspect().residentId;
    const residentPath = join(dataDir, "residents", `${residentId}.json`);
    const statePath = join(dataDir, "demo-state.json");
    const before = {
      resident: readFileSync(residentPath),
      state: readFileSync(statePath),
    };

    first.close();
    await expect(
      createPersistentDemoRuntime({
        dataDir,
        seed: { ...DEMO_SEED, id: "another-seed" },
      }),
    ).rejects.toThrow(/belongs to seed mist-rough-house-v1/);
    expect(readFileSync(residentPath)).toEqual(before.resident);
    expect(readFileSync(statePath)).toEqual(before.state);
  });

  it("播种中途失败会销毁半成品住户", async () => {
    const dataDir = freshDir();
    const real = createDriver({ dataDir });
    const failing = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "commit") return async () => Promise.reject(new Error("injected"));
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as HarnessDriver;

    await expect(seedDemoResident(failing)).rejects.toThrow("injected");
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("拒绝非法 id、空内容和重复内容", () => {
    expect(() => assertDemoSeed({ ...DEMO_SEED, id: "Mist Demo" })).toThrow(DemoSeedError);
    expect(() => assertDemoSeed({ ...DEMO_SEED, memories: [""] })).toThrow(/memory 不能为空/);
    expect(() => assertDemoSeed({ ...DEMO_SEED, commitments: ["重复", "重复"] })).toThrow(
      /commitment 不得重复/,
    );
  });
});
