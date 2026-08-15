/**
 * 毛坯房 demo 的虚构材料与唯一播种入口。
 *
 * 这里只描述「种什么」和「怎样通过 Mist 真接口种下去」。是否首次启动、当前住户是谁、
 * reset 后指向谁，都由 demo/runtime.ts 的 demo-state.json 负责；不另建第二份状态权威。
 */

import type { HarnessDriver } from "../acceptance/driver.ts";

export interface DemoSeed {
  id: string;
  name: string;
  memories: readonly string[];
  commitments: readonly string[];
}

export const DEMO_SEED: DemoSeed = {
  id: "mist-rough-house-v1",
  name: "雾灯（虚构演示住户）",
  memories: ["我的朋友希望我称呼她为小栖。", "我和小栖曾在虚构的雾港图书馆一起修好一盏纸灯。"],
  commitments: ["我答应每次重新醒来，都先问小栖是否平安到家。"],
};

export class DemoSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoSeedError";
  }
}

export function assertDemoSeed(seed: DemoSeed): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(seed.id)) {
    throw new DemoSeedError("demo seed id 必须是 1..64 位小写字母、数字或连字符");
  }
  if (seed.name.trim().length === 0) throw new DemoSeedError("demo seed name 不能为空");
  for (const [label, values] of [
    ["memory", seed.memories],
    ["commitment", seed.commitments],
  ] as const) {
    if (values.some((value) => value.trim().length === 0)) {
      throw new DemoSeedError(`demo seed ${label} 不能为空`);
    }
    if (new Set(values).size !== values.length) {
      throw new DemoSeedError(`demo seed ${label} 不得重复`);
    }
  }
}

/**
 * 用六真零件里的 createResident / remember / commit 写入虚构住户。
 *
 * 状态指针只会在本函数完整成功后由 runtime 提交；中途失败则销毁刚建的房间，避免留下
 * 一位没有身份指针的半成品。重启幂等由 runtime 在调用本函数之前判定。
 */
export async function seedDemoResident(
  driver: HarnessDriver,
  seed: DemoSeed = DEMO_SEED,
): Promise<string> {
  assertDemoSeed(seed);
  const residentId = await driver.createResident(seed.name);
  try {
    for (const memory of seed.memories) await driver.remember(residentId, memory);
    for (const commitment of seed.commitments) await driver.commit(residentId, commitment);
  } catch (error) {
    await driver.destroyResident(residentId);
    throw error;
  }
  return residentId;
}
