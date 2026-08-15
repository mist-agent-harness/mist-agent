import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistentDemoRuntime } from "../demo/runtime.ts";

const dirs: string[] = [];

function freshDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-demo-runtime-"));
  dirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const seed = {
  id: "runtime-test-seed",
  name: "编造的住户",
  memories: ["记得纸船是蓝色的。"],
  commitments: ["答应重启后仍认得纸船。"],
};

describe("persistent demo runtime", () => {
  it("keeps identity and resident state across restart while opening a new message root", async () => {
    const dataDir = freshDir();
    const reply = async (_residentId: string, message: string) => `脑子:${message}`;
    const first = await createPersistentDemoRuntime({ dataDir, reply, seed });
    const firstResidentId = first.inspect().residentId;
    await first.inspect().driver.say(firstResidentId, "重启前一句");

    const second = await createPersistentDemoRuntime({ dataDir, reply, seed });
    const secondResidentId = second.inspect().residentId;
    const bootPack = await second.bootPack();
    const answer = await second.inspect().driver.say(secondResidentId, "重启后第一句");
    const history = await second.inspect().driver.history(secondResidentId);
    const user = history.find((node) => node.role === "user");

    expect(secondResidentId).toBe(firstResidentId);
    expect(bootPack.identity).toBe(seed.name);
    expect(bootPack.memories.map((memory) => memory.content)).toEqual(seed.memories);
    expect(bootPack.commitments).toEqual(seed.commitments);
    expect(answer.content).toBe("脑子:重启后第一句");
    expect(user?.content).toBe("重启后第一句");
    expect(user?.parentId).toBeNull();
    expect(history.some((node) => node.content === "重启前一句")).toBe(false);
  });

  it("reset reseeds a new resident and removes the old snapshot", async () => {
    const dataDir = freshDir();
    const runtime = await createPersistentDemoRuntime({ dataDir, seed });
    const oldResidentId = runtime.inspect().residentId;

    await runtime.reset();

    const newResidentId = runtime.inspect().residentId;
    const snapshots = readdirSync(join(dataDir, "residents"));
    expect(newResidentId).not.toBe(oldResidentId);
    expect(snapshots).toEqual([`${newResidentId}.json`]);
    expect((await runtime.bootPack()).memories.map((memory) => memory.content)).toEqual(
      seed.memories,
    );
    const state = JSON.parse(readFileSync(join(dataDir, "demo-state.json"), "utf8"));
    expect(state.residentId).toBe(newResidentId);
    expect(state.seedId).toBe(seed.id);
    expect(state.schemaVersion).toBe(2);
  });

  it("fails closed for corrupt state and for snapshots without an identity pointer", async () => {
    const corrupt = freshDir();
    writeFileSync(
      join(corrupt, "demo-state.json"),
      JSON.stringify({ schemaVersion: 99, seedId: seed.id, residentId: "resident-missing" }),
    );
    await expect(createPersistentDemoRuntime({ dataDir: corrupt, seed })).rejects.toThrow(
      /unsupported demo state schema/,
    );

    const orphaned = freshDir();
    const first = await createPersistentDemoRuntime({ dataDir: orphaned, seed });
    rmSync(join(orphaned, "demo-state.json"));
    expect(first.inspect().residentId).toMatch(/^resident-/);
    await expect(createPersistentDemoRuntime({ dataDir: orphaned, seed })).rejects.toThrow(
      /snapshots exist without demo-state/,
    );
  });

  it("does not collect snapshots when the identity pointer cannot be opened", async () => {
    const dataDir = freshDir();
    const first = await createPersistentDemoRuntime({ dataDir, seed });
    const existingSnapshot = `${first.inspect().residentId}.json`;
    writeFileSync(
      join(dataDir, "demo-state.json"),
      JSON.stringify({ schemaVersion: 2, seedId: seed.id, residentId: "resident-missing" }),
    );

    await expect(createPersistentDemoRuntime({ dataDir, seed })).rejects.toThrow();
    expect(readdirSync(join(dataDir, "residents"))).toContain(existingSnapshot);
  });
});
