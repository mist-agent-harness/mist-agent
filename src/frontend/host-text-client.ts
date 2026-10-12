/**
 * D31-1 生产文字宿主客户端：spawn 现役宿主进程，经普通 IPC 调
 * `say`/`requireActiveResident`/`readStream`/`bootPack`/`breathe` 等既有能力。
 * adapter 不自建 writer、不默认 generation、不编造身份。
 *
 * 错误边界：失败只用固定 code/中文建议，**不回显上游 stderr/IPC 任意文本**；
 * 拥有 child 时先正常 stop 再等有限退出，确实不退才强杀；借用 owner 不 stop/close。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RESIDENT_HOST_PROCESS = fileURLToPath(
  new URL("../resident-runtime/host-process.ts", import.meta.url),
);

interface HostReply {
  readonly requestId?: string;
  readonly type?: string;
  readonly pid?: number;
  readonly bootId?: string;
  readonly ok?: boolean;
  readonly value?: unknown;
}

export interface HostResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class HostTextClientError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "HostTextClientError";
    this.code = code;
  }
}

const EXIT_WAIT_MS = 2_000;
let sequence = 0;

export class HostTextClient {
  readonly #dataDir: string;
  readonly #hostPath: string;
  #child: ChildProcess | null = null;
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(options: { dataDir: string; hostPath?: string }) {
    this.#dataDir = options.dataDir;
    this.#hostPath = options.hostPath ?? RESIDENT_HOST_PROCESS;
  }

  async start(): Promise<void> {
    if (this.#child !== null) return;
    const child = spawn(process.execPath, ["--import", "tsx", this.#hostPath], {
      env: {
        ...process.env,
        MIST_FRONTEND_HOST_DIR: this.#dataDir,
        MIST_RESIDENT_RUNTIME_DIR: this.#dataDir,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.#child = child;
    child.on("message", (message: HostReply) => this.#onMessage(message));
    child.once("exit", () => {
      if (this.#child === child) this.#child = null;
      this.#rejectAll("HOST_EXITED");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new HostTextClientError("HOST_STARTUP_TIMEOUT"));
        }, 15_000);
        const onMessage = (message: HostReply): void => {
          if (message.type !== "ready") return;
          cleanup();
          resolve();
        };
        const onExit = (): void => {
          cleanup();
          reject(new HostTextClientError("HOST_EXITED_BEFORE_READY"));
        };
        function cleanup(): void {
          clearTimeout(timer);
          child.off("message", onMessage);
          child.off("exit", onExit);
        }
        child.on("message", onMessage);
        child.once("exit", onExit);
      });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (this.#child === child) this.#child = null;
      this.#rejectAll("HOST_STARTUP_FAILED");
      throw error;
    }
  }

  /** 拥有子进程时正常 stop 并等有限退出；不退才强杀。借用 owner 不走这里。 */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    try {
      await this.#call("stop", {}, 2_000);
    } catch {
      // 正常 close 失败不阻塞清理
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, EXIT_WAIT_MS);
    await exited;
    clearTimeout(timer);
    if (this.#child === child) this.#child = null;
    this.#rejectAll("HOST_STOPPED");
  }

  call<T>(op: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.#call<T>(op, input, 30_000);
  }

  #call<T>(op: string, input: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const child = this.#child;
    if (child === null) return Promise.reject(new HostTextClientError("HOST_NOT_RUNNING"));
    sequence += 1;
    const requestId = `fe-host-${sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new HostTextClientError("HOST_CALL_TIMEOUT"));
      }, timeoutMs);
      this.#pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.send({ op, requestId, input }, (error) => {
        if (error === null) return;
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(new HostTextClientError("HOST_SEND_FAILED"));
      });
    });
  }

  #onMessage(message: HostReply): void {
    if (message.requestId === undefined) return;
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    this.#pending.delete(message.requestId);
    if (message.ok === true) pending.resolve(message.value);
    else pending.reject(new HostTextClientError("HOST_OP_FAILED"));
  }

  #rejectAll(code: string): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      pending.reject(new HostTextClientError(code));
    }
  }
}
