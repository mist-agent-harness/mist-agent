/**
 * 一位住户同一时刻只在一个宿主进程里开窗（D9：一条流，一个写方；#234 并发两宿主）。
 *
 * 一窗流整份重写落盘，两个进程各写各的必然丢事件；进程内已有 writer 所有权挡第二个
 * runtime，跨进程靠这把锁。一位住户一份 `<dataDir>/sessions/active/<residentId>.lock`
 * （0600，内容是持有进程的 pid、随机令牌与起锁时刻）。`ResidentRuntime#windowFor` 每次用到
 * 这位住户都先过这里（在认领暂停记录、调模型、写流之前）：第一次拿锁，之后每回合核对锁里
 * 还是自己的令牌；`close()` 之后一律拒绝，关完 writer 再放（只放令牌是自己的那份）。硬杀
 * 留下的锁，下次启动看 pid 已不在就接管。
 *
 * 建锁：先把完整内容写进本进程独有的临时文件，再 `link` 到锁路径——已存在就 EEXIST，
 * 与 `wx` 同样是原子的「只建一次」，但锁一出现就是写完的：直接 `wx` 建锁路径会露出
 * 一段空文件，被同时起的另一个进程当成坏锁接管，两边都以为自己拿到了。
 *
 * 锁在且 pid 活着、不是本进程：拒绝（调用方收成 writer-unavailable）。锁文件在却读不出
 * （EIO、EMFILE、EACCES 等）：核实不了谁拿着，同样拒绝，绝不当坏锁抢。锁路径被目录、符号
 * 链接等非文件占住：那不是 mist 的锁，也拒绝，要人把它挪走——本模块从不递归删除任何东西。
 * pid 已死（ESRCH）、就是本进程，或读出来解析不了：当陈锁接管。先给锁路径上此刻的那个东西
 * link 一个认领名 `<锁>.takeover-<陈锁原文的 sha256 前缀>`：同一份陈锁的认领名相同，link 排他，
 * 同时接管的几个进程只有一个认领得到。认领名读出来逐字就是判过陈的那份（普通文件），才删锁
 * 路径、删认领名，再按上面建锁。陈锁只有认领者会删，认领名在删完之前一直占着，所以删掉的一定
 * 是那份陈锁，不会是别人刚建的新锁；认领名读出来不是那份（锁已换人、变成符号链接等）或读不出，
 * 就只删自己刚建的认领名，锁路径一概不动。锁路径从不挪走、从不放回。前提是锁路径只经本模块
 * 改动：有人在核对与删除之间手动换掉锁文件，或同一进程里两个实例把对方的锁当成「就是本进程」
 * 的陈锁时，删的是那一刻锁路径上的东西（unlink 不能按 inode 有条件地删）。
 *
 * 所以不论几个进程同时起、同时接管同一把陈锁，都只有一个拿到；锁建上之后只有持有者自己放
 * （令牌对得上才删），或它死后被当成陈锁接管。被人手动删掉或换掉锁文件的持有者，在下一回合
 * 开头核对令牌时停下，不再重建这把锁、不再为这位住户开窗，关闭时也不落暂停记录（`stillHolds`），
 * 要退出重启。
 *
 * 代价：死进程的 pid 被系统复用给别的活进程时，这位住户会一直显示「在别处打开」，直到有人
 * 按提示删掉锁文件；锁路径被非文件占住时要人手动挪走；接管到一半（认领名建上、陈锁还没删）
 * 被硬杀，陈锁和认领名都留着，之后的进程认领不到、一直被拒，要人按提示删掉这两个文件（认领名
 * 建上、陈锁已删之后才被硬杀，只多留一个认领名文件，不挡任何人）；每回合多读一次锁文件；
 * 两个 pid 命名空间不同的容器共用一个数据目录时，存活判断不可靠——对方活着也可能被当成陈锁
 * 接管，本空间碰巧有同号进程时又会一直显示「在别处打开」。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LOCK_SCHEMA = 1;
/** 与住户档案、事实账、一窗流、暂停记录同一条住户号文件名闸。 */
const SAFE_RESIDENT_ID = /^[a-z0-9-]+$/;
const LOCK_KEYS = ["pid", "residentId", "schemaVersion", "startedAt", "token"];
/** 锁一直被抢走又放回时的重试上限；过了就当锁被别人拿着。 */
const ACQUIRE_ATTEMPTS = 3;

interface LockHolder {
  readonly pid: number;
  readonly token: string;
}

/**
 * 这位住户用不了：锁在另一个活进程手里、读不出、已被接管或删除，或本运行时已经 close()。调用方在调模型、
 * 写一窗流之前把它收成 writer-unavailable 的结构化失败（message + remedy）。
 */
export class ResidentHostLockError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "ResidentHostLockError";
    this.remedy = remedy;
  }
}

function assertResidentId(residentId: string): void {
  if (typeof residentId !== "string" || !SAFE_RESIDENT_ID.test(residentId)) {
    throw new Error(`resident id 不可作为文件名: ${residentId}`);
  }
}

/** 某位住户宿主锁的落盘位置（测试也从这里取，不另写一份路径）。 */
export function residentLockPath(dataDir: string, residentId: string): string {
  assertResidentId(residentId);
  return join(dataDir, "sessions", "active", `${residentId}.lock`);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** 锁路径上看到了什么。读不出（unreadable）与读出来是坏的（file 但解析不了）分开：前者不许接管。 */
type Observed =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly raw: string }
  | { readonly kind: "not-file" }
  | { readonly kind: "unreadable"; readonly code: string };

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "EUNKNOWN";
}

function observe(path: string): Observed {
  try {
    // 目录、符号链接等占住锁路径：不是谁的锁（真锁一律是 link 上来的普通文件）。
    if (!lstatSync(path).isFile()) return { kind: "not-file" };
    return { kind: "file", raw: readFileSync(path, "utf8") };
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", code };
  }
}

/** 删掉本进程自己刚建的认领名（只是个名字，不论它指向什么）；删不掉就留着，不会被当成锁。 */
function dropOwnName(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 留一个认领名残档：它的名字只对应那份陈锁，挡不住别的锁。
  }
}

/** 同一份陈锁只有一个认领名：由判过陈的那份原文定（原文里有随机令牌，不同的锁不撞名）。 */
function claimPathFor(path: string, staleRaw: string): string {
  const digest = createHash("sha256").update(staleRaw).digest("hex").slice(0, 32);
  return `${path}.takeover-${digest}`;
}

/** 接管的结局：接管了（陈锁已删）；认领名被别人占着；锁路径已经不是判过的那份陈锁。 */
type TakeOver =
  | { readonly kind: "taken" }
  | { readonly kind: "claimed-elsewhere"; readonly claim: string }
  | { readonly kind: "changed" };

function parseHolder(observed: Observed, residentId: string): LockHolder | null {
  if (observed.kind !== "file") return null;
  const raw = observed.raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== LOCK_KEYS.join(",")) return null;
  if (record.schemaVersion !== LOCK_SCHEMA || record.residentId !== residentId) return null;
  const { pid, token, startedAt } = record;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return null;
  if (typeof token !== "string" || token === "") return null;
  if (typeof startedAt !== "string" || startedAt === "") return null;
  return { pid, token };
}

/** pid 还在不在：ESRCH 是不在；EPERM 是在（别的用户的进程）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 完整内容先落独有临时文件再 link：锁路径已存在返回 false，出现即是写完的。 */
function createExclusive(path: string, content: string): boolean {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fsyncDirectory(dirname(path));
    return true;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留原始写入错误。
      }
    }
    rmSync(temporaryPath, { force: true });
  }
}

export class ResidentHostLocks {
  readonly #dataDir: string;
  /** 本进程拿到过的锁：residentId → 令牌。锁文件被人删掉或换掉后照旧留着，核对永远不过，直到重启。 */
  readonly #held = new Map<string, string>();
  #closed = false;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  /**
   * 用这位住户之前过锁：没拿过就拿；拿过就核对锁文件里还是自己的令牌（被接管、被删、
   * 读不出都拒绝）；`close()` 之后一律拒绝。拿不到抛 `ResidentHostLockError`；落盘本身
   * 失败（盘满、目录建不了）照原样抛，调用方按开窗失败处理。
   */
  acquire(residentId: string): void {
    if (this.#closed) {
      throw new ResidentHostLockError(
        `运行时已关闭，不再为住户 ${residentId} 开窗`,
        "重新启动宿主后再说话",
      );
    }
    const path = residentLockPath(this.#dataDir, residentId);
    const heldToken = this.#held.get(residentId);
    if (heldToken !== undefined) {
      this.#verify(residentId, heldToken, path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const content = JSON.stringify({
      schemaVersion: LOCK_SCHEMA,
      residentId,
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    });
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      if (createExclusive(path, content)) {
        this.#held.set(residentId, token);
        return;
      }
      const observed = observe(path);
      if (observed.kind === "missing") continue; // 持有者刚放了锁：再建一次。
      if (observed.kind === "unreadable") {
        throw this.#unverifiable(residentId, observed.code, path, false);
      }
      if (observed.kind === "not-file") throw this.#notALock(residentId, path);
      const holder = parseHolder(observed, residentId);
      if (holder !== null && holder.pid !== process.pid && isAlive(holder.pid)) {
        throw this.#busy(residentId, holder.pid, path);
      }
      const takeOver = this.#takeOver(residentId, path, observed.raw);
      if (takeOver.kind === "claimed-elsewhere") {
        throw this.#claimedElsewhere(residentId, path, takeOver.claim);
      }
      if (takeOver.kind === "taken" && createExclusive(path, content)) {
        this.#held.set(residentId, token);
        return;
      }
      // 认领时锁刚好被删掉（ENOENT）：空着就再建一次；别的情形照此刻看到的报。
      if (takeOver.kind === "changed" && observe(path).kind === "missing") continue;
      break;
    }
    const now = observe(path);
    if (now.kind === "unreadable") throw this.#unverifiable(residentId, now.code, path, false);
    if (now.kind === "not-file") throw this.#notALock(residentId, path);
    throw this.#busy(residentId, parseHolder(now, residentId)?.pid, path);
  }

  /** 从此不再拿锁、不再认可已拿的锁（runtime.close() 一开头就调）。重复调用无事。 */
  close(): void {
    this.#closed = true;
  }

  /**
   * 锁文件里此刻还是不是本进程的令牌。不看 close()（关闭时落暂停记录前用）；读不出、
   * 被换、被删、从没拿过都是 false。
   */
  stillHolds(residentId: string): boolean {
    const token = this.#held.get(residentId);
    if (token === undefined) return false;
    try {
      return (
        parseHolder(observe(residentLockPath(this.#dataDir, residentId)), residentId)?.token ===
        token
      );
    } catch {
      return false;
    }
  }

  /** 关闭时放掉本进程拿着的每把锁（只删令牌还是自己的那份）。隐含 close()；重复调用无事。 */
  releaseAll(): void {
    this.#closed = true;
    for (const [residentId, token] of this.#held) {
      const path = residentLockPath(this.#dataDir, residentId);
      try {
        if (parseHolder(observe(path), residentId)?.token === token) {
          rmSync(path, { force: true });
        }
      } catch {
        // 删不掉：本进程退出后 pid 不在，下次启动按陈锁接管。
      }
    }
    this.#held.clear();
  }

  /**
   * 每回合的令牌核对：锁文件里不是自己的令牌（被接管、被删）或读不出，就停下。被挤掉的
   * 进程不重建这把锁（`#held` 照旧留着），所以提示的是退出本宿主重启，不是删锁重试。
   */
  #verify(residentId: string, token: string, path: string): void {
    const observed = observe(path);
    if (parseHolder(observed, residentId)?.token === token) return;
    if (observed.kind === "unreadable") {
      throw this.#unverifiable(residentId, observed.code, path, true);
    }
    throw new ResidentHostLockError(
      `住户 ${residentId} 的锁已被接管或删除：本进程不再为它调模型、写一窗流`,
      `本进程不会再为这位住户开窗：先看锁文件 ${path} 里现在是哪个进程、那边是否还在用这位住户，然后退出本宿主再重新启动`,
    );
  }

  /**
   * 接管陈锁：给锁路径上此刻的那个东西 link 一个认领名（同一份陈锁同一个名字，link 排他）。
   * 认领名读出来逐字就是判过陈的那份普通文件，才删锁路径：陈锁只有认领者删，认领名删完陈锁
   * 才放，所以删掉的一定是那份陈锁。读出来不是那份（锁已换人、变成符号链接）或读不出：只删
   * 自己刚建的认领名，锁路径不动。认领名被别人占着：别人正在接管，或接管到一半被硬杀。
   */
  #takeOver(residentId: string, path: string, staleRaw: string): TakeOver {
    const claim = claimPathFor(path, staleRaw);
    try {
      linkSync(path, claim);
    } catch (error) {
      // EEXIST：认领名已在。其余（锁刚被删 ENOENT、锁路径成了目录 EPERM 等）：锁路径已经不是
      // 判过的那份，回头按此刻看到的报。
      return errorCode(error) === "EEXIST"
        ? { kind: "claimed-elsewhere", claim }
        : { kind: "changed" };
    }
    const claimed = observe(claim);
    if (claimed.kind !== "file" || claimed.raw !== staleRaw) {
      dropOwnName(claim);
      return { kind: "changed" };
    }
    try {
      unlinkSync(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        dropOwnName(claim);
        throw new ResidentHostLockError(
          `住户 ${residentId} 的陈锁删不掉（${errorCode(error)}）：本进程不开窗、不调模型、不写一窗流`,
          `修好 ${dirname(path)} 的写权限后重试；若确认没有别的 mist 进程在跑，删掉锁文件 ${path} 后重试`,
        );
      }
    }
    dropOwnName(claim);
    return { kind: "taken" };
  }

  /** 认领名被别人占着：别人正在接管这把陈锁，或接管到一半被硬杀留下了认领名。 */
  #claimedElsewhere(residentId: string, path: string, claim: string): ResidentHostLockError {
    return new ResidentHostLockError(
      `住户 ${residentId} 的陈锁正被另一个 mist 进程接管：本进程不开窗、不调模型、不写一窗流`,
      `稍后重试；若一直这样且确认没有别的 mist 进程在跑，删掉锁文件 ${path} 和认领名 ${claim} 后重试`,
    );
  }

  /** 从没拿到过这把锁的进程：提示到那边退出，或确认没人在跑后删锁重试。 */
  #busy(residentId: string, pid: number | undefined, path: string): ResidentHostLockError {
    const who = pid === undefined ? "另一个 mist 进程" : `另一个 mist 进程（pid ${pid}）`;
    return new ResidentHostLockError(
      `住户 ${residentId} 正在${who}里打开：本进程不开窗、不调模型、不写一窗流`,
      `先到那个进程里退出（/exit）再来；若确认没有别的 mist 进程在跑，删掉锁文件 ${path} 后重试`,
    );
  }

  #notALock(residentId: string, path: string): ResidentHostLockError {
    return new ResidentHostLockError(
      `住户 ${residentId} 的锁路径被不是 mist 锁的东西占着（目录、符号链接等）：本进程不开窗、不调模型、不写一窗流`,
      `${path} 不是 mist 的锁：看清里面是什么，把它挪到别处后重试`,
    );
  }

  #unverifiable(
    residentId: string,
    code: string,
    path: string,
    held: boolean,
  ): ResidentHostLockError {
    return new ResidentHostLockError(
      `住户 ${residentId} 的锁文件在却读不出（${code}）：核实不了是谁拿着，本进程不开窗、不调模型、不写一窗流`,
      held
        ? `修好锁文件 ${path} 的读取（权限、磁盘）后重试；本进程不会重建这把锁——它若已坏掉或被删，退出本宿主再重新启动`
        : `修好锁文件的读取（权限、磁盘）后重试；若确认没有别的 mist 进程在跑，删掉锁文件 ${path} 后重试`,
    );
  }
}
