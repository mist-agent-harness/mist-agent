import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDriver } from "../src/acceptance-driver.ts";
import { MessageTreeError } from "../src/message-tree/index.ts";
import { decodeResidentExportM0 } from "../src/migration/resident-migration.ts";
import { ResidentNotFoundError } from "../src/store/resident-store.ts";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-driver-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acceptance driver opts", () => {
  it("默认不传 opts 时保留原哑回应", async () => {
    const driver = createDriver();
    const residentId = await driver.createResident("default");

    const reply = await driver.say(residentId, "你好");

    expect(reply.content).toBe("收到：你好");
  });

  it("默认不传 opts 时 driver 全路径不在当前目录写文件", async () => {
    const cwd = process.cwd();
    const workDir = freshDir();
    process.chdir(workDir);
    try {
      const driver = createDriver();
      const residentId = await driver.createResident("memory-only");
      await driver.remember(residentId, "只在内存");
      await driver.commit(residentId, "答应过不落盘");
      await driver.say(residentId, "默认路径");
      await driver.history(residentId);
      await driver.buildBootPack(residentId);
      await driver.exportResident(residentId);
      await driver.killSession(residentId);
      await driver.destroyResident(residentId);

      expect(readdirSync(workDir)).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("未知住户错误来源保持默认路径原语义", async () => {
    const driver = createDriver();

    await expect(driver.history("ghost")).rejects.toThrow(MessageTreeError);
    await expect(driver.destroyResident("ghost")).rejects.toThrow(MessageTreeError);
    await expect(driver.say("ghost", "hi")).rejects.toThrow(ResidentNotFoundError);
    await expect(driver.reviseNode("ghost", "node", "hi")).rejects.toThrow(ResidentNotFoundError);
    await expect(driver.exportResident("ghost")).rejects.toThrow(ResidentNotFoundError);
  });

  it("reply 注入支持 async 回应并写进消息树", async () => {
    const driver = createDriver({
      reply: async (residentId, message) => `脑子:${residentId}:${message}`,
    });
    const residentId = await driver.createResident("reply");

    const reply = await driver.say(residentId, "开门");
    const history = await driver.history(residentId);

    expect(reply.content).toBe(`脑子:${residentId}:开门`);
    expect(history.map((node) => node.content)).toContain(`脑子:${residentId}:开门`);
    expect(history.map((node) => node.content)).not.toContain("[object Promise]");
  });

  it("dataDir 重启后读回住户态，但不伪装恢复消息树", async () => {
    const dataDir = freshDir();
    const first = createDriver({ dataDir });
    const residentId = await first.createResident("persisted");
    await first.remember(residentId, "记得我是谁");
    await first.commit(residentId, "答应过开灯");
    await first.say(residentId, "重启前的话");
    expect(readdirSync(dataDir).length).toBeGreaterThan(0);

    const second = createDriver({ dataDir });

    expect((await second.recall(residentId, "记得")).map((entry) => entry.content)).toEqual([
      "记得我是谁",
    ]);
    expect((await second.buildBootPack(residentId)).commitments).toEqual(["答应过开灯"]);
    expect(await second.history(residentId)).toEqual([]);
  });

  it("dataDir 恢复出的住户第一句 say 从新根开始", async () => {
    const dataDir = freshDir();
    const first = createDriver({ dataDir });
    const residentId = await first.createResident("restart");
    await first.remember(residentId, "重启后还在");

    const second = createDriver({ dataDir });
    const reply = await second.say(residentId, "重启后第一句");
    const history = await second.history(residentId);
    const user = history.find((node) => node.role === "user" && node.content === "重启后第一句");

    expect(reply.content).toBe("收到：重启后第一句");
    expect(user?.parentId).toBeNull();
  });

  it("dataDir 恢复出的住户可导出空消息树并可销毁", async () => {
    const dataDir = freshDir();
    const first = createDriver({ dataDir });
    const residentId = await first.createResident("quiet");
    await first.remember(residentId, "只写住户态");
    expect(readdirSync(dataDir).length).toBeGreaterThan(0);

    const second = createDriver({ dataDir });
    const pack = decodeResidentExportM0(await second.exportResident(residentId));
    expect(pack.history).toEqual([]);

    await expect(second.destroyResident(residentId)).resolves.toBeUndefined();
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
