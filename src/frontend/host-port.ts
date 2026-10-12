/**
 * D31-1 受限宿主端口：只读/受控写地复用现役 `ResidentRuntime` 的
 * `requireActiveResident`/`say`/`readStream`/`bootPack`，不新建 runtime/writer。
 *
 * 两种借用方式：
 *   - `InProcessResidentHostPort`：借本进程里已存在的 `ResidentRuntime`（宿主自己装配）。
 *   - `IpcResidentHostPort`：借真实 IPC 宿主（`src/resident-runtime/host-process.ts`）。
 * 端口无模型路由/权限语义；前端 close 只关前端资源，借用 owner 不被杀/不被 close。
 */
import type { ResidentRuntime } from "../resident-runtime/runtime.ts";
import type { HostTextClient } from "./host-text-client.ts";

export interface HostSayOutcome {
  readonly ok: boolean;
  readonly reply?: string;
  readonly generation?: number;
  readonly model?: string;
  readonly reason?: string | undefined;
}

export interface HostStreamEvent {
  readonly eventId: string;
  readonly kind: "user" | "assistant";
  readonly text: string;
}

export interface ResidentHostPort {
  requireActiveResident(
    referenceId: string,
  ): Promise<{ ok: boolean; residentId?: string; reason?: string | undefined }>;
  say(input: { residentId: string; text: string }): Promise<HostSayOutcome>;
  readStream(residentId: string): Promise<{ ok: boolean; events: readonly HostStreamEvent[] }>;
  bootPack(residentId: string): Promise<{ ok: boolean; identity?: string }>;
}

export class InProcessResidentHostPort implements ResidentHostPort {
  readonly #runtime: ResidentRuntime;

  constructor(runtime: ResidentRuntime) {
    this.#runtime = runtime;
  }

  async requireActiveResident(
    referenceId: string,
  ): Promise<{ ok: boolean; residentId?: string; reason?: string | undefined }> {
    const result = this.#runtime.requireActiveResident(referenceId);
    return result.ok
      ? { ok: true, residentId: result.value.residentId }
      : { ok: false, reason: String(result.reason) };
  }

  async say(input: { residentId: string; text: string }): Promise<HostSayOutcome> {
    const result = await this.#runtime.say(input);
    return result.ok
      ? {
          ok: true,
          reply: result.value.reply,
          generation: result.value.generation,
          model: result.value.model,
        }
      : { ok: false, reason: result.error?.code ?? "host-error" };
  }

  async readStream(
    residentId: string,
  ): Promise<{ ok: boolean; events: readonly HostStreamEvent[] }> {
    const result = this.#runtime.readStream({ residentId });
    if (!result.ok) return { ok: false, events: [] };
    return {
      ok: true,
      events: result.value.events.map((event) => ({
        eventId: event.eventId,
        kind: event.kind,
        text: event.text,
      })),
    };
  }

  async bootPack(residentId: string): Promise<{ ok: boolean; identity?: string }> {
    const result = this.#runtime.bootPack({ residentId });
    return result.ok ? { ok: true, identity: result.value.identity } : { ok: false };
  }
}

interface IpcHostResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class IpcResidentHostPort implements ResidentHostPort {
  readonly #client: HostTextClient;

  constructor(client: HostTextClient) {
    this.#client = client;
  }

  async requireActiveResident(
    referenceId: string,
  ): Promise<{ ok: boolean; residentId?: string; reason?: string | undefined }> {
    const result = await this.#client.call<IpcHostResult<{ residentId: string }>>(
      "requireActiveResident",
      { referenceId },
    );
    return result.ok && result.value !== undefined
      ? { ok: true, residentId: result.value.residentId }
      : { ok: false, reason: result.error?.code ?? "host-error" };
  }

  async say(input: { residentId: string; text: string }): Promise<HostSayOutcome> {
    const result = await this.#client.call<
      IpcHostResult<{ reply: string; generation: number; model: string }>
    >("say", input);
    return result.ok && result.value !== undefined
      ? {
          ok: true,
          reply: result.value.reply,
          generation: result.value.generation,
          model: result.value.model,
        }
      : { ok: false, reason: result.error?.code ?? "host-error" };
  }

  async readStream(
    residentId: string,
  ): Promise<{ ok: boolean; events: readonly HostStreamEvent[] }> {
    const result = await this.#client.call<
      IpcHostResult<{
        events: ReadonlyArray<{ eventId: string; kind: "user" | "assistant"; text: string }>;
      }>
    >("readStream", { residentId });
    return result.ok && result.value !== undefined
      ? {
          ok: true,
          events: result.value.events.map((event) => ({
            eventId: event.eventId,
            kind: event.kind,
            text: event.text,
          })),
        }
      : { ok: false, events: [] };
  }

  async bootPack(residentId: string): Promise<{ ok: boolean; identity?: string }> {
    const result = await this.#client.call<IpcHostResult<{ identity: string }>>("bootPack", {
      residentId,
    });
    return result.ok && result.value !== undefined
      ? { ok: true, identity: result.value.identity }
      : { ok: false };
  }
}
