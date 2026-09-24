/**
 * #120 window-history 生产宿主的**真实落盘故障注入**（WH-04）。
 *
 * 归属：本文件在 src/window-host/（允许落盘写与读的组装/宿主根），不在被 WH-06
 * 审计的 src/window-history/ 投影目录里。投影目录只读、不落盘；一切故障注入的落盘
 * 操作收拢在这里。
 *
 * 为什么要一层 fault-aware read port：先决①的 canonical stream store 在构造时把事件
 * 载入内存并严格校验（parseRecord + verifyCanonicalEvent），一份被写坏的
 * `*.stream.json` 会在 store 构造处直接抛错，而不是以 damaged[] 的形式浮上来；活着的
 * store 又只从内存回读，chmod 落盘文件对活进程的 eventsAfter 无效。所以要让「读不到」
 * 「读到损坏」在真实落盘层面机器可见，本层在 store 读端口外再包一层，按盘上的故障控制
 * 文件改写读路径：
 *   - 读屏障（injectStorageReadFailure）：落一个屏障标记文件；命中该窗时读端口抛错，
 *     投影转 storage-unavailable。清障即删标记。
 *   - 条目损坏（corruptDurableEntry）：真实翻转 `*.stream.json` 里目标条目 payload 的
 *     字节（真实字节篡改），并记一份损坏标记；命中损坏标记的住户，读端口改为**直接从盘
 *     上原始 JSON** 回读事件（绕开 store 的严格恢复），于是被翻字节的那条 verify 不过、
 *     进 damaged[]（hash-mismatch），健康条目照常返回、绝不静默丢。
 *   - 数据删除（deleteDurableWindowData，实现在 window-history-host.ts）：真实删掉该窗的
 *     落盘**呈现记录**（`*.wh-format.json`）并抹掉内存窗账；windowExists() 转假 =>
 *     window-not-found（不是空页）。**不动**共享住户流水文件 `*.stream.json`：先决①的
 *     底座是 append-only 的唯一底座，永不删事件（删了还会把同住户其他窗一起毁掉、并破坏
 *     streamSeq 连续性）。窗的存在权威因此是「底座事实 ∧ 格式记录」，详见
 *     window-history-host.ts 顶注「窗的存在权威」。
 *
 * chmod 依赖（明写，供文档与验收席）：读屏障用文件标记而非 chmod，是因为 root 会绕过
 * 权限位；本层用「屏障标记文件 + 读路径显式检查」实现，不依赖运行身份。但整套验收仍需
 * 以**非 root**跑（misttest 闸），因为仓里另有约十处 chmod-based 写失败测试在 root 下会
 * 假红——那是仓规，不是本层的额外要求。
 *
 * 代价（明写）：损坏路径要绕开 store 从盘上原始解析事件，多一份「盘上 JSON -> 事件」的
 * 解码；换来的是「单条 payload 损坏在返回值层面机器可见且不误伤健康条目」这条硬保证。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CanonicalEvent,
  type CanonicalStreamReadPort,
  StreamNotFoundError,
} from "../one-stream/index.ts";

/** 故障控制文件落在 dataDir 下的固定位置（不进 durableSnapshot 的比较面）。 */
const FAULT_DIR = "window-history.faults";
const READ_BARRIER_FILE = "read-barrier.json";
const CORRUPT_FILE = "corrupted.json";
/** 底座 store 的落盘文件后缀，用于损坏路径的原始回读。 */
const STREAM_SUFFIX = ".stream.json";

interface ReadBarrier {
  readonly residentId: string;
  readonly windowId: string;
}

interface CorruptMark {
  readonly residentId: string;
  readonly streamSeq: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 落盘故障注入器 + fault-aware 读端口包装。构造时从盘恢复故障标记（跨进程重启后
 * 仍是真值），这样注入过的故障在同一 dataDir 的新宿主里依旧生效。
 */
export class WindowHostFaultInjector implements CanonicalStreamReadPort {
  readonly #dataDir: string;
  readonly #faultDir: string;
  readonly #inner: CanonicalStreamReadPort;

  constructor(dataDir: string, inner: CanonicalStreamReadPort) {
    this.#dataDir = resolve(dataDir);
    this.#faultDir = join(this.#dataDir, FAULT_DIR);
    this.#inner = inner;
  }

  // —— fault-aware 读端口 ——

  eventsAfter(residentId: string, afterSeq: number): CanonicalEvent[] {
    const barrier = this.#readBarrier();
    if (barrier !== null && barrier.residentId === residentId) {
      throw new StreamNotFoundError(
        `injected storage read failure for ${residentId}/${barrier.windowId}`,
      );
    }
    const corruptions = this.#corruptions().filter((mark) => mark.residentId === residentId);
    if (corruptions.length === 0) {
      // 无损坏标记：正常走底座 store（内存态、已校验）。
      return this.#inner.eventsAfter(residentId, afterSeq);
    }
    // 有损坏标记：从盘上原始 JSON 回读，保留被翻字节的坏条目让投影 verify 失败。
    return this.#rawEventsAfter(residentId, afterSeq);
  }

  /** 从盘上 `*.stream.json` 原始回读事件（绕开 store 的严格恢复），保留坏字节。 */
  #rawEventsAfter(residentId: string, afterSeq: number): CanonicalEvent[] {
    const streamPath = join(this.#dataDir, `${residentId}${STREAM_SUFFIX}`);
    if (!existsSync(streamPath)) throw new StreamNotFoundError(residentId);
    const parsed: unknown = JSON.parse(readFileSync(streamPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.events)) {
      throw new StreamNotFoundError(residentId);
    }
    const events = parsed.events as CanonicalEvent[];
    return events.filter((event) => event.streamSeq > afterSeq);
  }

  // —— 故障注入（真实落盘）——

  injectStorageReadFailure(input: { residentId: string; windowId: string }): void {
    this.#ensureFaultDir();
    const barrier: ReadBarrier = { residentId: input.residentId, windowId: input.windowId };
    writeFileSync(join(this.#faultDir, READ_BARRIER_FILE), JSON.stringify(barrier));
  }

  clearStorageReadFailure(): void {
    rmSync(join(this.#faultDir, READ_BARRIER_FILE), { force: true });
  }

  /**
   * 真实翻转目标条目 payload 的字节：读回盘上原始 JSON，改写命中 streamSeq 的那条
   * payload（附一个篡改字段），写回盘上，并记一份损坏标记让读路径改走原始回读。
   */
  corruptDurableEntry(input: { residentId: string; streamSeq: number }): void {
    this.#ensureFaultDir();
    const streamPath = join(this.#dataDir, `${input.residentId}${STREAM_SUFFIX}`);
    if (existsSync(streamPath)) {
      const parsed = JSON.parse(readFileSync(streamPath, "utf8")) as unknown;
      if (isRecord(parsed) && Array.isArray(parsed.events)) {
        for (const event of parsed.events as Array<Record<string, unknown>>) {
          if (event.streamSeq !== input.streamSeq) continue;
          const payload = isRecord(event.payload) ? { ...event.payload } : {};
          // 真实翻字节：payload 变了但 payloadHash 不变 => verify 必不过。
          payload.__corrupted__ = true;
          event.payload = payload;
        }
        writeFileSync(streamPath, JSON.stringify(parsed));
      }
    }
    const marks = this.#corruptions();
    marks.push({ residentId: input.residentId, streamSeq: input.streamSeq });
    writeFileSync(join(this.#faultDir, CORRUPT_FILE), JSON.stringify(marks));
  }

  #ensureFaultDir(): void {
    mkdirSync(this.#faultDir, { recursive: true });
  }

  #readBarrier(): ReadBarrier | null {
    const path = join(this.#faultDir, READ_BARRIER_FILE);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as ReadBarrier;
  }

  #corruptions(): CorruptMark[] {
    const path = join(this.#faultDir, CORRUPT_FILE);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8")) as CorruptMark[];
  }
}
