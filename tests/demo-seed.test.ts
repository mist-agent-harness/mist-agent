import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEMO_COMMITMENTS,
  DEMO_MEMORIES,
  DEMO_RESIDENT_NAME,
  DemoSeedError,
  seedDemoResident,
} from "../demo/seed.ts";
import { createDriver } from "../src/acceptance-driver.ts";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-demo-seed-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("demo seed", () => {
  it("首次启动建立一位纯虚构住户，并用 remember/commit 写入固定材料", async () => {
    const dataRoot = freshDir();

    const result = await seedDemoResident({ dataRoot });
    const bootPack = await result.driver.buildBootPack(result.residentId);

    expect(result.created).toBe(true);
    expect(bootPack.identity).toBe(DEMO_RESIDENT_NAME);
    expect(bootPack.memories.map((memory) => memory.content)).toEqual([...DEMO_MEMORIES]);
    expect(bootPack.commitments).toEqual([...DEMO_COMMITMENTS]);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual([`${result.residentId}.json`]);
    expect(JSON.parse(readFileSync(join(dataRoot, "seed-manifest.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      seedId: "mist-rough-house-v1",
      residentId: result.residentId,
    });
    expect(existsSync(join(dataRoot, "seed.lock"))).toBe(false);
  });

  it("顺序重跑恢复同一住户，住户与 manifest 字节零新增", async () => {
    const dataRoot = freshDir();
    const first = await seedDemoResident({ dataRoot });
    const residentPath = join(dataRoot, "residents", `${first.residentId}.json`);
    const manifestPath = join(dataRoot, "seed-manifest.json");
    const before = {
      resident: readFileSync(residentPath),
      manifest: readFileSync(manifestPath),
      entries: readdirSync(join(dataRoot, "residents")),
    };

    const second = await seedDemoResident({ dataRoot });

    expect(second.created).toBe(false);
    expect(second.residentId).toBe(first.residentId);
    expect(readFileSync(residentPath)).toEqual(before.resident);
    expect(readFileSync(manifestPath)).toEqual(before.manifest);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual(before.entries);
  });

  it("住户已写入但 manifest 丢失时认回唯一住户，不复制第二位", async () => {
    const dataRoot = freshDir();
    const first = await seedDemoResident({ dataRoot });
    unlinkSync(join(dataRoot, "seed-manifest.json"));

    const recovered = await seedDemoResident({ dataRoot });

    expect(recovered.created).toBe(false);
    expect(recovered.residentId).toBe(first.residentId);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual([`${first.residentId}.json`]);
  });

  it("中断在部分播种时只补缺项，不重复已有项", async () => {
    const dataRoot = freshDir();
    const dataDir = join(dataRoot, "residents");
    const driver = createDriver({ dataDir });
    const residentId = await driver.createResident(DEMO_RESIDENT_NAME);
    await driver.remember(residentId, DEMO_MEMORIES[0]);

    const recovered = await seedDemoResident({ dataRoot });
    const bootPack = await recovered.driver.buildBootPack(residentId);

    expect(recovered.residentId).toBe(residentId);
    expect(bootPack.memories.map((memory) => memory.content)).toEqual([...DEMO_MEMORIES]);
    expect(bootPack.commitments).toEqual([...DEMO_COMMITMENTS]);
  });

  it("存量已经含重复种子项时 fail closed，不继续扩大重复", async () => {
    const dataRoot = freshDir();
    const driver = createDriver({ dataDir: join(dataRoot, "residents") });
    const residentId = await driver.createResident(DEMO_RESIDENT_NAME);
    await driver.remember(residentId, DEMO_MEMORIES[0]);
    await driver.remember(residentId, DEMO_MEMORIES[0]);
    const before = readFileSync(join(dataRoot, "residents", `${residentId}.json`));

    await expect(seedDemoResident({ dataRoot })).rejects.toThrow(/demo memory 已重复 2 次/);
    expect(readFileSync(join(dataRoot, "residents", `${residentId}.json`))).toEqual(before);
  });

  it("manifest 缺失且目录里不止一位住户时 fail closed", async () => {
    const dataRoot = freshDir();
    const driver = createDriver({ dataDir: join(dataRoot, "residents") });
    await driver.createResident(DEMO_RESIDENT_NAME);
    await driver.createResident("另一位虚构住户");

    await expect(seedDemoResident({ dataRoot })).rejects.toThrow(/有 2 位住户/);
    expect(readdirSync(join(dataRoot, "residents"))).toHaveLength(2);
  });

  it("坏 manifest 不会被当成首启重置", async () => {
    const dataRoot = freshDir();
    const first = await seedDemoResident({ dataRoot });
    writeFileSync(join(dataRoot, "seed-manifest.json"), "{broken");

    await expect(seedDemoResident({ dataRoot })).rejects.toThrow(DemoSeedError);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual([`${first.residentId}.json`]);
  });

  it("合法 JSON 但 schemaVersion 不符时 fail closed", async () => {
    const dataRoot = freshDir();
    mkdirForManifest(dataRoot);
    writeFileSync(
      join(dataRoot, "seed-manifest.json"),
      JSON.stringify({
        schemaVersion: 999,
        seedId: "mist-rough-house-v1",
        residentId: "resident-existing",
      }),
    );

    await expect(seedDemoResident({ dataRoot })).rejects.toThrow(/形状或版本不受支持/);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual([]);
  });

  it("合法 JSON 但 seedId 属于另一套种子时 fail closed", async () => {
    const dataRoot = freshDir();
    mkdirForManifest(dataRoot);
    writeFileSync(
      join(dataRoot, "seed-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        seedId: "another-demo-seed",
        residentId: "resident-existing",
      }),
    );

    await expect(seedDemoResident({ dataRoot })).rejects.toThrow(/形状或版本不受支持/);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual([]);
  });

  it("manifest 指向不存在的住户时拒绝另建一位", async () => {
    const dataRoot = freshDir();
    mkdirForManifest(dataRoot);
    writeFileSync(
      join(dataRoot, "seed-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        seedId: "mist-rough-house-v1",
        residentId: "resident-missing",
      }),
    );

    await expect(seedDemoResident({ dataRoot })).rejects.toThrow(/不存在的住户快照/);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual([]);
  });

  it("活锁存在时不碰住户目录", async () => {
    const dataRoot = freshDir();
    mkdirForManifest(dataRoot);
    const lockPath = join(dataRoot, "seed.lock");
    writeFileSync(lockPath, "busy", { mode: 0o600 });
    const before = readdirSync(join(dataRoot, "residents"));

    await expect(seedDemoResident({ dataRoot })).rejects.toThrow(/已被另一进程占用/);
    expect(readdirSync(join(dataRoot, "residents"))).toEqual(before);
    expect(readFileSync(lockPath, "utf8")).toBe("busy");
  });

  it("新建的 manifest 与运行中 lock 使用 0600", async () => {
    const dataRoot = freshDir();
    const pending = seedDemoResident({ dataRoot });
    const lockPath = join(dataRoot, "seed.lock");
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    await pending;
    const manifestPath = join(dataRoot, "seed-manifest.json");

    expect(readFileSync(manifestPath, "utf8")).toContain("mist-rough-house-v1");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(existsSync(lockPath)).toBe(false);
  });
});

function mkdirForManifest(dataRoot: string): void {
  mkdirSync(join(dataRoot, "residents"), { recursive: true });
}
