/**
 * #194（RT-01～RT-08）的**生产验收驱动**。acceptance/resident-runtime-run.ts import
 * 本文件并调用 createResidentRuntimeDriver()；缺本文件时八盏灯全红（判卷先行的起点）。
 *
 * 真实性纪律（照 src/window-history-acceptance-driver.ts 的口径）：
 *   - startHost() 真 spawn 子进程 src/resident-runtime/host-process.ts（spawn + stdio ipc
 *     + {requestId, ok, value|error} 把手），返回真实 {pid, bootId, dataDir}；bootId/pid
 *     每次 boot 都不同。**第一次用到宿主方法时自动起宿主**（RT-01 全程不调 startHost）。
 *   - 每个方法都转发给正在跑的子进程；killHost 是真 SIGKILL，重启只能从盘上读回。
 *   - 一个 driver 实例一个稳定 dataDir，跨 kill/restart 复用，reset() 才 rm -rf 重建。
 *   - 模型往返经 MIST_RESIDENT_RUNTIME_TRANSPORT 选传输（默认合成通道，见
 *     src/resident-runtime/channels.ts 顶注：公开 CI 不带密钥；真实 pi 传输随 RT-04）。
 *
 * 出处归结构（清单「真灯与桩灯」）：被判的运行时实现在 src/resident-runtime/ 各模块；
 * 正常行为方法只做 IPC 接线。RT-08 的三个故障夹具只在宿主停止时破坏临时数据根，
 * 并由判卷另行读回正对照；它们不实现被判行为。STUBBED 为空，所有行为仍经真实宿主。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CandidateSnapshot,
  Result as IdentityResult,
} from "../acceptance/resident-continuity-driver.ts";
import type {
  BootPackView,
  BreathTrigger,
  BreatheOutcome,
  ChannelRoute,
  ChannelSpec,
  HostDescriptor,
  LetterTimeline,
  ResidentRuntimeDriver,
  Result,
  SecretScanReport,
  StreamFileInventory,
  StreamSnapshot,
  TuiStep,
  TuiTranscript,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";

/** 生产验收驱动没有桩方法；所有调用均转发给真实宿主子进程。 */
export const STUBBED: readonly string[] = [];

const HOST_PROCESS = fileURLToPath(new URL("./resident-runtime/host-process.ts", import.meta.url));
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface HostReply {
  readonly requestId?: string;
  readonly type?: string;
  readonly pid?: number;
  readonly bootId?: string;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name?: string; readonly message?: string };
}

let requestSequence = 0;

class ResidentRuntimeProductionDriver implements ResidentRuntimeDriver {
  readonly #dataDir: string;
  #child: ChildProcess | null = null;
  #descriptor: HostDescriptor | null = null;

  constructor() {
    // 稳定的每实例落盘根：跨 kill/restart 复用，reset() 才清掉重建。
    this.#dataDir = mkdtempSync(join(tmpdir(), "mist-resident-runtime-"));
  }

  // —— 真实宿主：起得来、杀得死、拉得起 ——

  async startHost(): Promise<HostDescriptor> {
    if (this.#child !== null) await this.killHost();
    return this.#spawnHost();
  }

  async killHost(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    this.#descriptor = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }

  async hostDescriptor(): Promise<HostDescriptor> {
    return this.#requireDescriptor();
  }

  async reset(): Promise<void> {
    await this.killHost();
    rmSync(this.#dataDir, { recursive: true, force: true });
    mkdirSync(this.#dataDir, { recursive: true });
  }

  // —— 通道（D25） ——

  provisionChannel(input: {
    residentId: string;
    channel: ChannelSpec;
    canarySecret: string;
  }): Promise<Result<ProvisionedChannelForward>> {
    return this.#ensureActiveResident(input.residentId).then(() =>
      this.#call("provisionChannel", { input }),
    );
  }

  async revokeCredential(input: { residentId: string }): Promise<void> {
    await this.#call("revokeCredential", { input });
  }

  resolveChannelRoute(input: { channel: ChannelSpec }): Promise<Result<ChannelRoute>> {
    return this.#call("resolveChannelRoute", { input });
  }

  // —— 对话往返 ——

  say(input: { residentId: string; text: string; turnId?: string }): Promise<Result<TurnResult>> {
    return this.#ensureActiveResident(input.residentId).then(() => this.#call("say", { input }));
  }

  modelInvocationCount(): Promise<number> {
    return this.#call("modelInvocationCount", {});
  }

  async armTurnConfirmationWriteFault(input: { residentId: string }): Promise<void> {
    await this.#ensureActiveResident(input.residentId);
    mkdirSync(join(this.#dataDir, "turns"), { recursive: true });
    mkdirSync(this.#turnReceiptTemporaryPath(input.residentId));
  }

  repairTurnConfirmationWriteFault(input: { residentId: string }): Promise<void> {
    rmSync(this.#turnReceiptTemporaryPath(input.residentId), { recursive: true, force: true });
    return Promise.resolve();
  }

  async crashAfterUserWrite(input: { residentId: string; turnId: string }): Promise<void> {
    assertFixtureResidentId(input.residentId);
    await this.killHost();
    const streamPath = join(this.#dataDir, "streams", `${input.residentId}.stream.json`);
    const record = parseObjectFile(streamPath);
    const events = requireArray(record.events, "stream events");
    const idempotency = requireArray(record.idempotency, "stream idempotency");
    const matching = events.filter((event) => eventTurnId(event) === input.turnId);
    const user = matching.find((event) => eventRole(event) === "user");
    const assistant = matching.find((event) => eventRole(event) === "assistant");
    if (user === undefined || assistant === undefined || matching.length !== 2) {
      throw new Error(`cannot create orphan fixture for ${input.residentId}/${input.turnId}`);
    }
    const assistantId = requireString(assistant.eventId, "assistant eventId");
    const retainedEvents = events.filter((event) => event !== assistant);
    const retainedIdempotency = idempotency.filter(
      (entry) => idempotencyEventId(entry) !== assistantId,
    );
    if (retainedIdempotency.length !== idempotency.length - 1) {
      throw new Error(`assistant idempotency row missing for ${input.residentId}/${input.turnId}`);
    }
    writeFileSync(
      streamPath,
      JSON.stringify({
        ...record,
        nextSeq: retainedEvents.length + 1,
        events: retainedEvents,
        idempotency: retainedIdempotency,
      }),
      "utf8",
    );

    const turnsPath = join(this.#dataDir, "turns", `${input.residentId}.turns.json`);
    if (existsSync(turnsPath)) {
      const turnsRecord = parseObjectFile(turnsPath);
      const turns = requireArray(turnsRecord.turns, "turn confirmations");
      writeFileSync(
        turnsPath,
        JSON.stringify({
          ...turnsRecord,
          turns: turns.filter((entry) => objectString(entry, "turnId") !== input.turnId),
        }),
        "utf8",
      );
    }
    await this.startHost();
  }

  // —— 一窗流只读 ——

  readStream(input: { residentId: string }): Promise<Result<StreamSnapshot>> {
    return this.#call("readStream", { input });
  }

  streamFiles(): Promise<Result<StreamFileInventory>> {
    return this.#call("streamFiles", {});
  }

  // —— 启动包与交接信 ——

  bootPack(input: { residentId: string }): Promise<Result<BootPackView>> {
    return this.#call("bootPack", { input });
  }

  letterTimeline(input: { residentId: string }): Promise<Result<LetterTimeline>> {
    return this.#call("letterTimeline", { input });
  }

  // —— 换气（D8，RT-03 的地盘） ——

  setBreathThreshold(input: {
    residentId: string;
    windowId: string;
    generation: number;
    thresholdTokens: number;
    authority: "window" | "owner";
  }): Promise<Result<void>> {
    return this.#call("setBreathThreshold", { input });
  }

  breathe(input: { residentId: string; via: BreathTrigger }): Promise<Result<BreatheOutcome>> {
    return this.#call("breathe", { input });
  }

  async suddenDeath(input: { residentId: string }): Promise<void> {
    await this.#call("suddenDeath", { input });
  }

  archivedTranscript(input: {
    residentId: string;
    generation: number;
  }): Promise<Result<StreamSnapshot>> {
    return this.#call("archivedTranscript", { input });
  }

  // —— TUI（RT-05 的地盘） ——

  tuiTranscript(input: {
    residentId: string;
    channel: ChannelSpec;
    script: readonly TuiStep[];
  }): Promise<Result<TuiTranscript>> {
    return this.#ensureActiveResident(input.residentId).then(() =>
      this.#call("tuiTranscript", { input }),
    );
  }

  // —— 静态审计的检索根（RT-07） ——

  auditRoots(): Promise<readonly string[]> {
    // 「mist 当宿主，pi 当零件库」：pi 扩展不另起写入面，无扩展根可追加。
    return Promise.resolve([]);
  }

  // —— 凭证扫描（RT-06） ——

  secretScan(input: { residentId: string; needle: string }): Promise<Result<SecretScanReport>> {
    return this.#call("secretScan", { input });
  }

  // —— IPC ——

  async #spawnHost(): Promise<HostDescriptor> {
    const child = spawn(process.execPath, ["--import", "tsx", HOST_PROCESS], {
      env: { ...process.env, MIST_RESIDENT_RUNTIME_DIR: this.#dataDir },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.#child = child;
    const descriptor = await waitForReady(child, this.#dataDir);
    this.#descriptor = descriptor;
    return descriptor;
  }

  #requireDescriptor(): Promise<HostDescriptor> {
    if (this.#descriptor !== null) return Promise.resolve(this.#descriptor);
    return this.#spawnHost();
  }

  #call<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    return this.#requireDescriptor().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const child = this.#child;
          if (child === null) {
            reject(new Error("resident runtime host is not running"));
            return;
          }
          requestSequence += 1;
          const requestId = `rr-request-${requestSequence}`;
          const timer = setTimeout(
            () =>
              cleanup(new Error(`resident runtime host request timed out: ${op} (${requestId})`)),
            REQUEST_TIMEOUT_MS,
          );
          const onMessage = (message: HostReply): void => {
            if (message.requestId !== requestId) return;
            if (message.ok === true) {
              cleanupDone();
              resolve(message.value as T);
            } else {
              cleanup(new Error(message.error?.message ?? `host op failed: ${op}`));
            }
          };
          const onExit = (): void => {
            cleanup(new Error(`resident runtime host exited before answering ${op}`));
          };
          // 用 const 箭头而非 function 声明：声明会提升、丢掉 child 的非空收窄。
          const cleanupDone = (): void => {
            clearTimeout(timer);
            child.off("message", onMessage);
            child.off("exit", onExit);
          };
          const cleanup = (error: Error): void => {
            cleanupDone();
            reject(error);
          };
          child.on("message", onMessage);
          child.once("exit", onExit);
          child.send({ op, requestId, ...payload }, (error) => {
            if (error === null) return;
            cleanup(error);
          });
        }),
    );
  }

  async #ensureActiveResident(residentId: string): Promise<void> {
    const current = await this.#call<IdentityResult<unknown>>("requireActiveResident", {
      input: { referenceId: residentId },
    });
    if (current.ok) return;
    if (current.reason !== "resident-not-found") {
      throw new Error(`acceptance resident ${residentId} is not activatable: ${current.reason}`);
    }
    const candidate = await this.#call<CandidateSnapshot>("createCandidate", {
      input: {
        persona: `acceptance-persona:${residentId}`,
        proposedBy: { kind: "installer", id: "resident-runtime-acceptance" },
        residentId,
      },
    });
    const attested = await this.#call<IdentityResult<CandidateSnapshot>>("attestCandidate", {
      input: {
        candidateId: candidate.candidateId,
        actor: { kind: "candidate", candidateId: candidate.candidateId },
        decision: "accepted",
      },
    });
    if (!attested.ok || attested.value.residentId !== residentId) {
      throw new Error(`failed to activate acceptance resident ${residentId}`);
    }
  }

  #turnReceiptTemporaryPath(residentId: string): string {
    assertFixtureResidentId(residentId);
    return join(this.#dataDir, "turns", `${residentId}.turns.json.tmp`);
  }
}

/** 结构与契约 ProvisionedChannel 相同；host 走 JSON，这里只做转发类型。 */
type ProvisionedChannelForward = ChannelRoute & { readonly credentialRef: string };

function assertFixtureResidentId(residentId: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(residentId)) {
    throw new Error(`unsafe acceptance residentId: ${residentId}`);
  }
}

function parseObjectFile(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object in ${path}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${name} entry must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function objectString(value: Record<string, unknown>, key: string): string | null {
  const member = value[key];
  return typeof member === "string" ? member : null;
}

function eventTurnId(event: Record<string, unknown>): string | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return objectString(payload as Record<string, unknown>, "turnId");
}

function eventRole(event: Record<string, unknown>): string | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return objectString(payload as Record<string, unknown>, "role");
}

function idempotencyEventId(entry: Record<string, unknown>): string | null {
  const receipt = entry.receipt;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  return objectString(receipt as Record<string, unknown>, "eventId");
}

function stub<T>(method: string, plan: string): Promise<T> {
  return Promise.reject(
    new Error(`${method} 尚未接线（明桩，见 STUBBED）：${plan}。桩不冒充现成。`),
  );
}

function waitForReady(child: ChildProcess, dataDir: string): Promise<HostDescriptor> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => cleanup(new Error(`resident runtime host startup timed out: ${stderr}`)),
      READY_TIMEOUT_MS,
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const onMessage = (message: HostReply): void => {
      if (message.type !== "ready") return;
      if (typeof message.pid !== "number" || typeof message.bootId !== "string") return;
      cleanupDone();
      resolve({ pid: message.pid, bootId: message.bootId, dataDir });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup(
        new Error(
          `resident runtime host exited ${String(code)}/${String(signal)} before ready: ${stderr}`,
        ),
      );
    };
    function cleanupDone(): void {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    function cleanup(error: Error): void {
      cleanupDone();
      reject(error);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

export function createResidentRuntimeDriver(): ResidentRuntimeDriver {
  return new ResidentRuntimeProductionDriver();
}
