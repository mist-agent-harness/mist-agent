import { randomUUID } from "node:crypto";
/**
 * #218 / D31-1 前端适配层**验收驱动**：真正业务在 `src/frontend/host-text-engine.ts`
 * 产品文字 engine（经受限宿主端口 `say()` 写账）+ `src/frontend/webui-install.ts`。
 * 本文件只做判卷编排：spawn 夹具宿主（真 `assembleResidentRuntime` + 受控 transport）、
 * 住户/通道测试准备、模型请求观测、安装器与旧 official-skin 读取接线。
 *
 * 文字成功回合走同一个产品 engine（`sendCompletion` 与 HTTP `startFrontendHost` 都接它）；
 * 本驱动不再自建 writer、不拼 canonical、不写 surface-projection。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterBinding,
  AttachmentWriteReadback,
  CanonicalEventReadback,
  FrontendAdapterDriver,
  FrontendChatRequest,
  FrontendRequestContext,
  FrontendResponse,
  InstallerRunReadback,
  InteractionReadback,
  LegacyFrontendReadback,
  ModelTurnReadback,
  NetworkAttemptReadback,
  RawWireExchange,
  ResidentReply,
  SecurityAuditReadback,
  WebuiAuditReadback,
  WebuiCommandReadback,
  WebuiEnvironment,
} from "../acceptance/frontend-adapter-driver.ts";
import type { TurnResult } from "../acceptance/resident-runtime-driver.ts";
import {
  type SyntheticWebuiApi,
  startSyntheticWebuiApi,
} from "../tests/fixtures/synthetic-webui-api.ts";
import { type FrontendHost, startFrontendHost } from "./frontend/frontend-host.ts";
import { IpcResidentHostPort } from "./frontend/host-port.ts";
import { type HostResult, HostTextClient } from "./frontend/host-text-client.ts";
import { HostTextEngine } from "./frontend/host-text-engine.ts";
import { serializeRequest } from "./frontend/openai-wire.ts";
import { WebuiInstaller } from "./frontend/webui-install.ts";
import {
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
  WebuiSystemPlatform,
} from "./frontend/webui-platform.ts";
import type { FrontendChoice } from "./installer/contracts.ts";
import { InstallerController } from "./installer/controller.ts";
import { readLegacyOfficialSkin } from "./installer/legacy-frontend.ts";
import { InstallerStateStore } from "./installer/state-store.ts";
import { PRIVATE_SCOPE } from "./session/session-registry.ts";

const HOST_FIXTURE = fileURLToPath(
  new URL("../tests/fixtures/frontend-text-host.ts", import.meta.url),
);

export const STUBBED: readonly string[] = [];

interface BindingState {
  binding: AdapterBinding;
  modelTurns: ModelTurnReadback[];
  chain: Promise<unknown>;
}

interface ModelRequestView {
  residentId: string;
  text: string;
  history: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
}

function legalResidentId(synthetic: string): string {
  const normalized = synthetic
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length === 0 ? "resident-synthetic" : normalized;
}

/** Synthetic external CLI/service boundary. The real platform, plugin transaction, and HTTP API stay active. */
class AcceptanceWebuiCommandRunner implements CommandRunner {
  readonly #containers = new Set<string>();
  readonly #processes = new Set<string>();

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    if (invocation.args.includes("--version"))
      return { code: 0, stdout: "Python 3.12.13", stderr: "" };
    if (invocation.args.includes("venv") && invocation.args.includes("--help"))
      return { code: 0, stdout: "venv", stderr: "" };
    if (invocation.file === "docker" && invocation.args[0] === "info")
      return { code: 0, stdout: "acceptance-docker", stderr: "" };
    if (invocation.file === "docker" && invocation.args[0] === "inspect")
      return { code: 0, stdout: "true", stderr: "" };
    if (invocation.args.some((arg) => arg.endsWith("/health")))
      return { code: 0, stdout: '{"status":true}\n200', stderr: "" };
    if (invocation.args.some((arg) => arg.endsWith("/models")))
      return { code: 0, stdout: "401\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  async startContainer(
    invocation: CommandInvocation & { name: string },
  ): Promise<{ containerId: string }> {
    this.#containers.add(invocation.name);
    return { containerId: `synthetic:${invocation.name}` };
  }

  async startProcess(invocation: CommandInvocation & { name: string }): Promise<{ pid: number }> {
    this.#processes.add(invocation.name);
    return { pid: 1 };
  }

  async stopContainer(name: string): Promise<void> {
    this.#containers.delete(name);
  }
  async stopProcess(name: string): Promise<void> {
    this.#processes.delete(name);
  }
  async isProcessAlive(name: string): Promise<boolean> {
    return this.#processes.has(name);
  }
}

class AcceptanceFrontendAdapter implements FrontendAdapterDriver {
  readonly #rootDir: string;
  readonly #dataDir: string;
  #client: HostTextClient;
  #engine: HostTextEngine | null = null;
  #frontendHost: FrontendHost | null = null;
  #hostStarted = false;
  readonly #bindings = new Map<string, BindingState>();
  #webuiPromise: Promise<WebuiInstaller> | null = null;
  #webuiApi: SyntheticWebuiApi | null = null;

  constructor() {
    this.#rootDir = mkdtempSync(join(tmpdir(), "mist-frontend-acceptance-"));
    this.#dataDir = join(this.#rootDir, "runtime");
    mkdirSync(this.#dataDir, { recursive: true });
    this.#client = new HostTextClient({ dataDir: this.#dataDir, hostPath: HOST_FIXTURE });
  }

  #getWebui(): Promise<WebuiInstaller> {
    this.#webuiPromise ??= this.#createWebui();
    return this.#webuiPromise;
  }

  async #createWebui(): Promise<WebuiInstaller> {
    const api = await startSyntheticWebuiApi({
      email: "admin@mist.local",
      password: "synthetic-admin",
      acceptAny: true,
    });
    this.#webuiApi = api;
    const platform = new WebuiSystemPlatform({
      dataDir: join(this.#rootDir, "webui-platform"),
      runner: new AcceptanceWebuiCommandRunner(),
      resolveEndpoint: (endpointId) => {
        const binding = [...this.#bindings.values()].find(
          (entry) => entry.binding.endpointId === endpointId,
        );
        if (binding === undefined || this.#frontendHost === null)
          throw new Error("unregistered adapter endpoint");
        return this.#frontendHost.url;
      },
      managementBaseUrl: api.url,
      isPortFree: async () => true,
      healthMaxAttempts: 1,
      healthPollIntervalMs: 0,
    });
    return new WebuiInstaller({
      dataDir: join(this.#rootDir, "webui-plugins"),
      appliance: platform,
    });
  }

  async reset(): Promise<void> {
    if (this.#webuiPromise !== null) {
      const webui = await this.#webuiPromise;
      await webui.reset();
      await this.#webuiApi?.close();
      this.#webuiPromise = null;
      this.#webuiApi = null;
    }
    await this.#stopHost();
    rmSync(this.#dataDir, { recursive: true, force: true });
    mkdirSync(this.#dataDir, { recursive: true });
    this.#bindings.clear();
  }

  // —— FE-01 ——

  runInstaller(input: { frontend: "default" | "external" }): Promise<InstallerRunReadback> {
    const directory = mkdtempSync(join(this.#rootDir, "install-"));
    const store = new InstallerStateStore(directory);
    const controller = new InstallerController(store);
    controller.start("frontend-install", "discard");
    const credentialRef = {
      id: "frontend-install-key",
      type: "api_key" as const,
      issuerId: "mist-installer-api-key",
    };
    controller.saveCredentials([
      {
        credential: {
          ref: credentialRef,
          label: "Frontend install key",
          providerId: "mist",
          status: "incomplete",
        },
        secret: "synthetic-frontend-install",
      },
    ]);
    controller.saveBindings([
      {
        residentId: "frontend-install",
        lane: "primary",
        adapterId: "pi",
        credentialRef: { ...credentialRef },
      },
    ]);
    const choice: FrontendChoice =
      input.frontend === "default"
        ? { kind: "terminal" }
        : { kind: "external", integration: "openai-compatible" };
    controller.saveFrontend(choice);
    controller.saveMemory({ kind: "create", path: join(directory, "memory") });
    const receipt = controller.commit();
    return Promise.resolve({
      committed: true,
      defaulted: input.frontend === "default",
      frontend: receipt.config.frontend,
    });
  }

  readLegacyOfficialSkin(rawConfig: string): Promise<LegacyFrontendReadback> {
    return Promise.resolve(readLegacyOfficialSkin(rawConfig));
  }

  // —— 生产文字 engine 接线（测试准备：真实宿主 createCandidate/attest/provision）——

  async provisionBinding(input: {
    residentId: string;
    scopeId: string;
    label: string;
  }): Promise<AdapterBinding> {
    const engine = await this.#ensureHost();
    const reference = legalResidentId(input.residentId);
    const candidate = await this.#client.call<{ candidateId: string }>("createCandidate", {
      persona: `persona:${reference}`,
      proposedBy: { kind: "installer", id: "frontend-adapter" },
      residentId: reference,
    });
    await this.#client.call("attestCandidate", {
      candidateId: candidate.candidateId,
      actor: { kind: "candidate", candidateId: candidate.candidateId },
      decision: "accepted",
    });
    const active = await this.#client.call<HostResult<{ residentId: string }>>(
      "requireActiveResident",
      {
        referenceId: reference,
      },
    );
    if (!active.ok || active.value === undefined) {
      throw new Error(
        `host could not activate resident ${reference}: ${active.error?.code ?? "unknown"}`,
      );
    }
    const residentId = active.value.residentId;
    await this.#client.call("provisionChannel", {
      residentId,
      channel: { claudeSubscription: false, credentialKind: "api-key", model: "pi-test/model" },
      canarySecret: "synthetic-canary-secret",
    });
    const binding: AdapterBinding = {
      bindingId: `binding:${input.label}`,
      endpointId: `endpoint:${input.label}`,
      residentId,
      // 真实宿主 scope 用 SessionRegistry 的 PRIVATE_SCOPE 常量；不把 fixture 输入 scope 当权威。
      scopeId: PRIVATE_SCOPE,
      streamId: `stream:${residentId}`,
      token: `mist-token-${randomUUID()}`,
      serverModel: `mist:${input.label}`,
      // 一窗流事件没有 writerId；这里是宿主 owner 的 adapter 投影（同住户同一 owner）。
      canonicalWriterId: `owner:${residentId}`,
    };
    await engine.registerBinding(binding);
    this.#bindings.set(binding.bindingId, { binding, modelTurns: [], chain: Promise.resolve() });
    return binding;
  }

  async seedCanonicalHistory(bindingId: string, text: string[]): Promise<void> {
    if (text.length !== 2)
      throw new Error("seedCanonicalHistory expects exactly [user, assistant]");
    const state = this.#state(bindingId);
    await this.#client.call("enqueueReply", {
      residentId: state.binding.residentId,
      text: text[1] ?? "",
    });
    const result = await this.#client.call<HostResult<TurnResult>>("say", {
      residentId: state.binding.residentId,
      text: text[0] ?? "",
    });
    if (!result.ok) throw new Error(`seed say failed: ${result.error?.code ?? "unknown"}`);
  }

  async readAdapterUrl(bindingId: string): Promise<string> {
    this.#state(bindingId);
    await this.#ensureHost();
    if (this.#frontendHost === null) throw new Error("frontend listener is not running");
    return this.#frontendHost.url;
  }

  async queueResidentReply(bindingId: string, reply: ResidentReply): Promise<void> {
    if (reply.kind === "text") {
      const state = this.#state(bindingId);
      await this.#client.call("enqueueReply", {
        residentId: state.binding.residentId,
        text: reply.text,
      });
    }
  }

  async sendCompletion(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    return this.#turn(bindingId, context, request, false);
  }

  readRawWire(bindingId: string): Promise<RawWireExchange[]> {
    this.#state(bindingId);
    return this.#requireEngine().readRawWire(bindingId);
  }

  readModelTurns(bindingId: string): Promise<ModelTurnReadback[]> {
    return Promise.resolve(structuredClone(this.#state(bindingId).modelTurns));
  }

  readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]> {
    this.#state(bindingId);
    return this.#requireEngine().readCanonicalEvents(bindingId);
  }

  readInteractions(_bindingId: string): Promise<InteractionReadback[]> {
    return Promise.resolve([]);
  }

  readAttachmentWrites(): Promise<AttachmentWriteReadback> {
    return Promise.resolve({ count: 0, records: [] });
  }

  readNetworkAttempts(): Promise<NetworkAttemptReadback> {
    return Promise.resolve({ attempts: 0, records: [] });
  }

  readSecurityAudit(): Promise<SecurityAuditReadback> {
    return Promise.resolve(this.#requireEngine().readSecurityAudit());
  }

  // —— /webui ——

  async runWebuiCommand(
    bindingId: string,
    input: { confirmed: boolean; environment: WebuiEnvironment },
  ): Promise<WebuiCommandReadback> {
    return (await this.#getWebui()).run(this.#state(bindingId).binding, input);
  }

  async sendWebuiCompletion(
    serviceId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    const bindingId = (await this.#getWebui()).serviceBinding(serviceId);
    if (bindingId === null) {
      return {
        status: 404,
        error: {
          code: "WEBUI_SERVICE_NOT_FOUND",
          type: "mist_request_error",
          message: "WEBUI_SERVICE_NOT_FOUND",
          param: null,
        },
        body: null,
        chunks: [],
      };
    }
    return this.#turn(bindingId, context, request, true);
  }

  async readWebuiAudit(): Promise<WebuiAuditReadback> {
    return (await this.#getWebui()).readAudit();
  }

  // —— 内部 ——

  async #turn(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
    viaListener: boolean,
  ): Promise<FrontendResponse> {
    const state = this.#state(bindingId);
    // 每 binding 串行：并发回合由宿主 say 串行，观测也按真实请求关联。
    const run = state.chain.then(async () => {
      const engine = this.#requireEngine();
      const residentId = state.binding.residentId;
      const before = (
        await this.#client.call<readonly ModelRequestView[]>("readModelRequests", {})
      ).filter((request) => request.residentId === residentId).length;
      let response: FrontendResponse;
      if (viaListener) {
        const listener = this.#frontendHost;
        if (listener === null) throw new Error("frontend listener is not running");
        const wireResponse = await fetch(`${listener.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            ...(context.token === null ? {} : { Authorization: `Bearer ${context.token}` }),
            "Content-Type": "application/json",
          },
          body: serializeRequest(request),
          redirect: "manual",
        });
        const raw = await wireResponse.text();
        response = this.#readWireResponse(
          wireResponse.status,
          wireResponse.headers.get("content-type"),
          raw,
        );
      } else {
        const handled = await engine.handle(bindingId, context, request);
        response = handled.response;
      }
      const requests = (
        await this.#client.call<readonly ModelRequestView[]>("readModelRequests", {})
      ).filter((request) => request.residentId === residentId);
      const current = requests[before];
      if (response.status === 200 && current !== undefined) {
        state.modelTurns.push({
          residentId: state.binding.residentId,
          scopeId: state.binding.scopeId,
          canonicalHistoryText: current.history.map((message) => message.text),
          currentText: current.text,
          attachments: [],
          surfaceCapabilities: [...(request.mist?.client?.capabilities ?? [])],
        });
      }
      return response;
    });
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #state(bindingId: string): BindingState {
    const state = this.#bindings.get(bindingId);
    if (state === undefined) throw new Error(`unknown binding: ${bindingId}`);
    return state;
  }

  #readWireResponse(status: number, contentType: string | null, raw: string): FrontendResponse {
    let parsed: unknown;
    try {
      if (!contentType?.includes("text/event-stream")) parsed = JSON.parse(raw);
      else parsed = null;
    } catch {
      parsed = null;
    }
    if (contentType?.includes("text/event-stream")) {
      const chunks: FrontendResponse["chunks"] = [];
      let text = "";
      let finalFrame: Record<string, unknown> | null = null;
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          chunks.push({
            textDelta: "",
            attachments: [],
            interaction: null,
            projection: null,
            done: true,
          });
          continue;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }
        if (typeof frame !== "object" || frame === null) continue;
        const record = frame as Record<string, unknown>;
        const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
        if (typeof choice !== "object" || choice === null) continue;
        const item = choice as Record<string, unknown>;
        const delta = item.delta;
        if (typeof delta === "object" && delta !== null) {
          const piece = (delta as Record<string, unknown>).content;
          if (typeof piece === "string") {
            text += piece;
            chunks.push({
              textDelta: piece,
              attachments: [],
              interaction: null,
              projection: null,
              done: false,
            });
          }
        }
        if (item.finish_reason === "stop") finalFrame = record;
      }
      const mist =
        finalFrame !== null && typeof finalFrame.mist === "object" && finalFrame.mist !== null
          ? (finalFrame.mist as Record<string, unknown>)
          : {};
      const projectionRaw =
        typeof mist.projection === "object" && mist.projection !== null
          ? (mist.projection as Record<string, unknown>)
          : {};
      const projection: FrontendResponse["body"] extends infer _T
        ? {
            status: "native" | "degraded" | "blocked";
            missingCapabilities: [];
            canonicalEventIds: string[];
          }
        : never = {
        status:
          projectionRaw.status === "degraded" || projectionRaw.status === "blocked"
            ? projectionRaw.status
            : "native",
        missingCapabilities: [],
        canonicalEventIds: Array.isArray(projectionRaw.canonical_event_ids)
          ? projectionRaw.canonical_event_ids.filter((id): id is string => typeof id === "string")
          : [],
      };
      return {
        status,
        error: null,
        body: {
          id: typeof finalFrame?.id === "string" ? finalFrame.id : "",
          model: typeof finalFrame?.model === "string" ? finalFrame.model : "",
          streamId: typeof mist.stream_id === "string" ? mist.stream_id : "",
          text,
          attachments: [],
          interaction: null,
          projection,
        },
        chunks,
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        status,
        error: {
          code: "MIST_RESPONSE_INVALID",
          type: "mist_request_error",
          message: "MIST_RESPONSE_INVALID",
          param: null,
        },
        body: null,
        chunks: [],
      };
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.error === "object" && record.error !== null) {
      const error = record.error as Record<string, unknown>;
      return {
        status,
        error: {
          code: typeof error.code === "string" ? error.code : "MIST_REQUEST_ERROR",
          type: typeof error.type === "string" ? error.type : "mist_request_error",
          message: typeof error.message === "string" ? error.message : "MIST_REQUEST_ERROR",
          param: typeof error.param === "string" ? error.param : null,
        },
        body: null,
        chunks: [],
      };
    }
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const message =
      typeof choices[0] === "object" && choices[0] !== null
        ? (choices[0] as Record<string, unknown>).message
        : null;
    const mist =
      typeof record.mist === "object" && record.mist !== null
        ? (record.mist as Record<string, unknown>)
        : {};
    const projectionRaw =
      typeof mist.projection === "object" && mist.projection !== null
        ? (mist.projection as Record<string, unknown>)
        : {};
    const statusValue = projectionRaw.status;
    return {
      status,
      error: null,
      body: {
        id: typeof record.id === "string" ? record.id : "",
        model: typeof record.model === "string" ? record.model : "",
        streamId: typeof mist.stream_id === "string" ? mist.stream_id : "",
        text:
          typeof message === "object" &&
          message !== null &&
          typeof (message as Record<string, unknown>).content === "string"
            ? ((message as Record<string, unknown>).content as string)
            : "",
        attachments: [],
        interaction: null,
        projection: {
          status: statusValue === "degraded" || statusValue === "blocked" ? statusValue : "native",
          missingCapabilities: [],
          canonicalEventIds: Array.isArray(projectionRaw.canonical_event_ids)
            ? projectionRaw.canonical_event_ids.filter((id): id is string => typeof id === "string")
            : [],
        },
      },
      chunks: [],
    };
  }

  #requireEngine(): HostTextEngine {
    if (this.#engine === null) throw new Error("frontend host engine is not running");
    return this.#engine;
  }

  async #ensureHost(): Promise<HostTextEngine> {
    if (!this.#hostStarted) {
      await this.#client.start();
      this.#hostStarted = true;
      this.#engine = new HostTextEngine(new IpcResidentHostPort(this.#client));
      this.#frontendHost = await startFrontendHost({ engine: this.#engine });
    }
    return this.#requireEngine();
  }

  async #stopHost(): Promise<void> {
    if (!this.#hostStarted) return;
    await this.#frontendHost?.close();
    this.#frontendHost = null;
    await this.#client.stop();
    this.#hostStarted = false;
    this.#engine = null;
    this.#client = new HostTextClient({ dataDir: this.#dataDir, hostPath: HOST_FIXTURE });
  }
}

export function createFrontendAdapterDriver(): FrontendAdapterDriver {
  return new AcceptanceFrontendAdapter();
}
