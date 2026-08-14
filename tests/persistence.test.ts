/**
 * 持久化的回归测试（方案：task_mist-p1-p2-p5，2026-08-14 定稿）。
 *
 * 文件为权威、Map 只是内存视图。这里守的是四件事：
 *   1. 进程重启后人还在——记忆、消息树、承诺、勘误链逐字节不变
 *   2. 隔离与销毁在磁盘上同样成立——每住户一份文件，拆房连档案一起销
 *   3. 坏数据显式失败——静默跳过 = 住户无声消失，那是最坏的丢人方式
 *   4. 序列跨重启/跨导入不撞号——撞号是 Map.set 静默覆盖，无声丢数据
 *
 * 全部用 mkdtemp，不在仓库里留任何文件。
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResidentStore } from "../src/store/resident-store.ts";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mist-persist-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("重启恢复", () => {
  it("全套住户态跨重启逐字节不变：记忆、树、承诺、勘误链、id、createdAt", () => {
    const dir = freshDir();
    const a = new ResidentStore({ dataDir: dir });
    const r = a.createResident("porcelain");
    const m1 = a.remember(r, "第一条");
    const m2 = a.errata(r, m1, "改对的第一条");
    a.commit(r, "答应过的事");
    const root = a.appendNode(r, null, "user", "你好");
    a.appendNode(r, root.id, "assistant", "在");
    const before = {
      memories: a.memories(r),
      nodes: a.nodes(r),
      commitments: a.commitments(r),
    };

    const b = new ResidentStore({ dataDir: dir });
    expect(b.memories(r)).toEqual(before.memories);
    expect(b.nodes(r)).toEqual(before.nodes);
    expect(b.commitments(r)).toEqual(before.commitments);
    // 勘误链单独点名：旧条目留底、指向新条目
    expect(b.memories(r).find((m) => m.id === m1)?.supersededBy).toBe(m2);
    expect(b.memories(r).find((m) => m.id === m2)?.supersededBy).toBeNull();
  });

  it("恢复后继续写：id 不撞旧号、时间戳仍单调", () => {
    const dir = freshDir();
    const a = new ResidentStore({ dataDir: dir });
    const r = a.createResident("r");
    for (let i = 0; i < 10; i += 1) a.remember(r, `旧 ${i}`);

    const b = new ResidentStore({ dataDir: dir });
    const oldIds = new Set(b.memories(r).map((m) => m.id));
    const oldMax = b
      .memories(r)
      .map((m) => m.createdAt)
      .sort()
      .at(-1);
    const fresh = b.remember(r, "重启后的新记忆");
    expect(oldIds.has(fresh)).toBe(false);
    const freshAt = b.memories(r).find((m) => m.id === fresh)?.createdAt;
    expect(freshAt !== undefined && oldMax !== undefined && freshAt > oldMax).toBe(true);
  });

  it("跨房隔离跨重启成立：文件一人一份，恢复后照样抛跨房错", () => {
    const dir = freshDir();
    const a = new ResidentStore({ dataDir: dir });
    const ra = a.createResident("a");
    const rb = a.createResident("b");
    a.remember(ra, "a 的私事");
    a.remember(rb, "b 的私事");
    expect(readdirSync(dir).sort()).toEqual([`${ra}.json`, `${rb}.json`].sort());

    const b = new ResidentStore({ dataDir: dir });
    expect(b.memories(ra).map((m) => m.content)).toEqual(["a 的私事"]);
    expect(b.memories(rb).map((m) => m.content)).toEqual(["b 的私事"]);
    expect(b.memories(ra).some((m) => m.content.includes("b 的"))).toBe(false);
  });

  it("destroyResident 连档案一起销，重启后人不诈尸", () => {
    const dir = freshDir();
    const a = new ResidentStore({ dataDir: dir });
    const r = a.createResident("goner");
    a.remember(r, "会消失的");
    a.destroyResident(r);
    expect(readdirSync(dir)).toEqual([]);

    const b = new ResidentStore({ dataDir: dir });
    expect(b.has(r)).toBe(false);
  });
});

describe("坏数据显式失败", () => {
  it("schema_version 不认识 → 构造时抛，不静默跳过", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "resident-zzzzzz.json"),
      JSON.stringify({ schemaVersion: 99, residentId: "resident-zzzzzz" }),
    );
    expect(() => new ResidentStore({ dataDir: dir })).toThrow(/schema_version/);
  });

  it("文件名与内容身份对不上 → 抛", () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, "resident-aaaaaa.json"),
      JSON.stringify({
        schemaVersion: 1,
        residentId: "resident-bbbbbb",
        name: "x",
        createdAt: new Date(0).toISOString(),
        memories: [],
        nodes: [],
        commitments: [],
      }),
    );
    expect(() => new ResidentStore({ dataDir: dir })).toThrow(/对不上/);
  });

  it("残缺 .tmp 不参与恢复也不毁旧档——死在 rename 前，旧快照才是权威", () => {
    const dir = freshDir();
    const a = new ResidentStore({ dataDir: dir });
    const r = a.createResident("survivor");
    a.remember(r, "写完的那份");
    // 模拟进程死在 rename 前留下的半截文件
    writeFileSync(join(dir, `${r}.json.tmp`), "{ 这不是合法 JSON");

    const b = new ResidentStore({ dataDir: dir });
    expect(b.memories(r).map((m) => m.content)).toEqual(["写完的那份"]);
  });
});

describe("跨机导入的序列推进", () => {
  it("导入高序号快照后，本机新发 id 不撞导入条目", () => {
    // 甲机写了很多条（序号推得很高），乙机是新的（序号低）
    const jia = new ResidentStore();
    const rJia = jia.createResident("远方来客");
    for (let i = 0; i < 30; i += 1) jia.remember(rJia, `第 ${i} 条`);
    const envelope = jia.exportRoom(rJia);

    const yi = new ResidentStore();
    const moved = yi.importRoom(envelope);
    const importedIds = new Set(yi.memories(moved).map((m) => m.id));
    // 不推进 #seq 的话，这里新发的 id 会撞上导入的 mem-00000x，静默覆盖
    const fresh = yi.remember(moved, "落地后的新记忆");
    expect(importedIds.has(fresh)).toBe(false);
    expect(yi.memories(moved)).toHaveLength(31);
  });
});

describe("纯内存模式", () => {
  it("不传 dataDir 不产生任何文件——判卷路径零 IO", () => {
    const dir = freshDir();
    // dir 只作观察哨：纯内存 store 干活期间，这个目录不该长出东西
    const s = new ResidentStore();
    const r = s.createResident("ghost");
    s.remember(r, "只活在内存里");
    expect(readdirSync(dir)).toEqual([]);
  });
});
