/**
 * 住户宿主锁的确定性竞态与读失败（Grok 评审 #234 锁）：在 node:fs 的 link / unlink /
 * readFileSync 上挂钩，把「几个进程抢同一把陈锁」和「判过之后锁路径变成目录或符号链接」卡进判陈
 * 与认领之间的空档，以及把锁文件、认领名读不出造出来。真进程的并发抢锁见 resident-lock.test.ts。
 */
import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResidentHostLockError,
  ResidentHostLocks,
  residentLockPath,
} from "../src/resident-runtime/resident-lock.ts";

const hooks = vi.hoisted(() => ({
  /** 接管时 link(锁, 认领名) 真正执行之前跑一次（一次性）。 */
  beforeClaim: null as (() => void) | null,
  /** 读这些路径时抛这个错误码。 */
  readFails: null as ((path: string) => string | null) | null,
  /** 删锁路径（不是认领名）时抛这个错误码。 */
  unlinkLockFails: null as string | null,
  /**
   * 照 macOS 的 link(2)：源是符号链接时链到它解引用后的目标（Linux 不解引用）。
   * 打开后任何平台上都按 macOS 的语义跑。
   */
  linkFollowsSymlinks: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fail = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: simulated`), { code });
  return {
    ...actual,
    linkSync: (existing: PathLike, target: PathLike): void => {
      const hook = hooks.beforeClaim;
      if (hook !== null && String(target).includes(".takeover-")) {
        hooks.beforeClaim = null;
        hook();
      }
      if (hooks.linkFollowsSymlinks && actual.lstatSync(existing).isSymbolicLink()) {
        actual.linkSync(actual.realpathSync(existing), target);
        return;
      }
      actual.linkSync(existing, target);
    },
    unlinkSync: (path: PathLike): void => {
      if (hooks.unlinkLockFails !== null && String(path).endsWith(".lock")) {
        throw fail(hooks.unlinkLockFails);
      }
      actual.unlinkSync(path);
    },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const code = hooks.readFails?.(String(args[0])) ?? null;
      if (code !== null) throw fail(code);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

/** 测试自己造符号链接用原版，不触发放回钩子。 */
const unhookedFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const roots: string[] = [];

afterEach(() => {
  hooks.beforeClaim = null;
  hooks.readFails = null;
  hooks.unlinkLockFails = null;
  hooks.linkFollowsSymlinks = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mist-resident-lock-takeover-"));
  roots.push(root);
  return root;
}

/** 写一把形状合法的锁；pid 给一个肯定不在的大号，就是陈锁。 */
function writeLock(root: string, holder: { pid: number; token: string }): string {
  const path = residentLockPath(root, "r-a");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      residentId: "r-a",
      pid: holder.pid,
      token: holder.token,
      startedAt: "2026-10-17T00:00:00.000Z",
    }),
  );
  return path;
}

const DEAD_PID = 2 ** 22 + 12_345;
/** 判过陈的那份锁原文对应的认领名（与锁模块同一个算法）。 */
const claimOf = (path: string): string =>
  `${path}.takeover-${createHash("sha256").update(readFileSync(path, "utf8")).digest("hex").slice(0, 32)}`;
const tokenAt = (path: string): string =>
  (JSON.parse(readFileSync(path, "utf8")) as { token: string }).token;

function refusalOf(action: () => void): ResidentHostLockError {
  try {
    action();
  } catch (error) {
    if (error instanceof ResidentHostLockError) return error;
    throw error;
  }
  throw new Error("预期被拒却拿到了锁");
}

describe("ResidentHostLocks：几个进程抢同一把陈锁（认领名）", () => {
  it("别的进程先接管完、建上新锁：本进程认领到的是那把新锁，只删自己的认领名，新锁不动", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    const a = new ResidentHostLocks(root);
    const b = new ResidentHostLocks(root);
    // A 判过陈锁、正要认领时，B 先把这把陈锁接管完并建上自己的锁。
    hooks.beforeClaim = () => b.acquire("r-a");
    expect(refusalOf(() => a.acquire("r-a")).message).toMatch(/正在另一个 mist 进程/);
    expect(b.stillHolds("r-a")).toBe(true);
    expect(tokenAt(path)).not.toBe("stale");
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
  });

  it("认领名被占着（别人正在接管，或接管到一半被硬杀）：拒绝并给出两个文件，陈锁与认领名都不动", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    const claim = claimOf(path);
    unhookedFs.linkSync(path, claim);
    const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
    expect(refused.message).toMatch(/正被另一个 mist 进程接管/);
    expect(refused.remedy).toContain(path);
    expect(refused.remedy).toContain(claim);
    expect(tokenAt(path)).toBe("stale");
    expect(readdirSync(dirname(path)).sort()).toEqual(["r-a.lock", basename(claim)].sort());
    // 按提示删掉两个文件，之后正常起的进程拿得到。
    rmSync(path);
    rmSync(claim);
    expect(() => new ResidentHostLocks(root).acquire("r-a")).not.toThrow();
  });

  it("认领名留着、陈锁已被删（接管到最后一步前被硬杀）：不挡后来的进程", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    const claim = claimOf(path);
    unhookedFs.linkSync(path, claim);
    rmSync(path);
    const locks = new ResidentHostLocks(root);
    expect(() => locks.acquire("r-a")).not.toThrow();
    expect(locks.stillHolds("r-a")).toBe(true);
  });

  it("认领时陈锁刚被删掉（ENOENT）：锁路径空着就再建一次，拿到，不报别人拿着", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    hooks.beforeClaim = () => rmSync(path);
    const locks = new ResidentHostLocks(root);
    expect(() => locks.acquire("r-a")).not.toThrow();
    expect(locks.stillHolds("r-a")).toBe(true);
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
  });

  it("陈锁删不掉：照实报错，不冒充别人拿着；认领名删掉，陈锁原样", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    hooks.unlinkLockFails = "EACCES";
    const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
    hooks.unlinkLockFails = null;
    expect(refused.message).toMatch(/陈锁删不掉（EACCES）/);
    expect(refused.message).not.toMatch(/正在另一个 mist 进程/);
    expect(refused.remedy).toContain(path);
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
    expect(tokenAt(path)).toBe("stale");
  });
});

describe("ResidentHostLocks：锁文件读不出就拒绝，不当坏锁抢", () => {
  it.each(["EIO", "EMFILE", "EACCES"])(
    "锁文件在、读它抛 %s（认领名再读也抛）：拒绝并给出锁路径，锁原样留着",
    (code) => {
      const root = tempRoot();
      const path = writeLock(root, { pid: process.pid, token: "unverifiable" });
      hooks.readFails = (target) => (target.includes("r-a.lock") ? code : null);
      const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
      expect(refused.message).toContain(`读不出（${code}）`);
      expect(refused.remedy).toContain(path);
      hooks.readFails = null;
      expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
      expect(tokenAt(path)).toBe("unverifiable");
    },
  );

  it("坏锁的认领名读不出：不算核对通过，只删认领名，坏锁原样并认输", () => {
    const root = tempRoot();
    const path = residentLockPath(root, "r-a");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "garbage");
    hooks.readFails = (target) => (target.includes(".takeover-") ? "EIO" : null);
    refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
    hooks.readFails = null;
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
    expect(readFileSync(path, "utf8")).toBe("garbage");
  });

  it("拿着的锁每回合核对时读不出：停下，不当作还拿着", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    hooks.readFails = (target) => (target.endsWith("r-a.lock") ? "EIO" : null);
    expect(refusalOf(() => locks.acquire("r-a")).message).toContain("读不出（EIO）");
  });
});

describe("ResidentHostLocks：判过陈锁之后锁路径变成非文件（锁路径不动，绝不递归删除）", () => {
  it("变成装着东西的目录：认领不了，目录与里面的东西原样；拒绝并说那不是 mist 的锁", () => {
    const root = tempRoot();
    const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
    hooks.beforeClaim = () => {
      rmSync(path);
      mkdirSync(join(path, "nested"), { recursive: true });
      writeFileSync(join(path, "nested", "keep.txt"), "别人的东西");
    };
    const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "nested", "keep.txt"), "utf8")).toBe("别人的东西");
    expect(refused.message).toContain("不是 mist 锁");
    expect(refused.remedy).toContain(path);
    expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
  });

  it.each([
    ["Linux（link 不解引用）", false],
    ["macOS（link 解引用到目标）", true],
  ])(
    "变成符号链接，%s：只删自己的认领名，链接与它指向的东西都不动；拒绝并说那不是 mist 的锁",
    (_label, followsSymlinks) => {
      const root = tempRoot();
      const path = writeLock(root, { pid: DEAD_PID, token: "stale" });
      hooks.linkFollowsSymlinks = followsSymlinks;
      const target = join(root, "elsewhere.txt");
      writeFileSync(target, "链接指向的东西");
      hooks.beforeClaim = () => {
        rmSync(path);
        unhookedFs.symlinkSync(target, path);
      };
      const refused = refusalOf(() => new ResidentHostLocks(root).acquire("r-a"));
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("链接指向的东西");
      expect(statSync(target).nlink).toBe(1);
      expect(refused.message).toContain("不是 mist 锁");
      expect(readdirSync(dirname(path))).toEqual(["r-a.lock"]);
    },
  );
});

describe("ResidentHostLocks.stillHolds", () => {
  it("锁文件读不出就不算还拿着", () => {
    const root = tempRoot();
    const locks = new ResidentHostLocks(root);
    locks.acquire("r-a");
    expect(locks.stillHolds("r-a")).toBe(true);
    hooks.readFails = (target) => (target.endsWith("r-a.lock") ? "EIO" : null);
    expect(locks.stillHolds("r-a")).toBe(false);
  });
});
