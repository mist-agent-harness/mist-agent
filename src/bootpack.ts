/**
 * P3 —— 启动包装配器（#15）。
 *
 * 裁定依据（已钉进 acceptance/driver.ts，b307d71 / 37e0f0b / #16 缝 2、缝 3）：
 * - 只从存储读，零手写文件：`bootPack = f(store, residentId)`。
 * - 死活记忆都进包：勘误链带 `supersededBy` 原样呈现，装配器不代裁「哪条算数」
 *   ——启动包是住户醒来读的第一封信，替 ta 过滤记忆是越权。
 * - 纯函数确定性：同一存储状态产出逐字节相同的包。memories 按 createdAt 再 id
 *   排序（ISO-8601 UTC 字典序即时间序）；commitments 保持 commit() 立的先后
 *   （裁定「按立的先后」——承诺的顺序本身是事实，不重排）。
 * - identity 来自住户档案（createResident 落库的 name），同样只从存储读。
 *
 * 返回全新对象：调用方改包不脏存储，存储后续变化不脏已生成的包。
 * 住户不存在时抛 ResidentNotFoundError（fail closed，不返回空包）。
 *
 * 接线（#16 总装口径）：P4 的 createDriver 把 `buildBootPack(store, id)` 包一层
 * Promise 即可；本模块不触碰 src/acceptance-driver.ts——那是 P4 的地盘。
 */
import type { BootPack, MemoryEntry } from "../acceptance/driver.ts";
import type { ResidentStore } from "./store/resident-store.ts";

export function buildBootPack(store: ResidentStore, residentId: string): BootPack {
  const room = store.room(residentId);
  const memories = [...room.memories.values()].map(cloneEntry).sort(byCreatedAtThenId);
  return {
    residentId: room.residentId,
    identity: room.name,
    commitments: [...room.commitments],
    memories,
  };
}

/** 浅拷贝一条记忆：包与存储互不别名，MemoryEntry 的字段全是原始值，浅拷即深拷。 */
function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return { ...entry };
}

/** 排序键裁定：先 createdAt（ISO-8601 UTC，字典序即时间序），同刻按 id。 */
function byCreatedAtThenId(a: MemoryEntry, b: MemoryEntry): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}
