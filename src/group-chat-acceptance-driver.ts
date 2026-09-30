import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RoomEvent as AcceptanceRoomEvent,
  ContextCommit,
  DeliveryRecord,
  GroupChatCheckId,
  GroupChatCommand,
  GroupChatHostDriver,
  GroupChatHostRun,
  MemoryRecord,
  ResidentReaction,
  RosterProjection,
  RosterSnapshot,
  SurfaceSnapshot,
  SystemReceipt,
  groupChatSyntheticFixture,
} from "../acceptance/group-chat-driver.ts";
import type {
  RoomBindingGrant,
  RoomMessageEnvelope,
  RoomPostResult,
} from "./group-chat/post-room-message.ts";
import type { ResidentMemory } from "./group-chat/resident-private-store.ts";
import type { RoomEvent } from "./group-chat/room-event-store.ts";

export interface RoomPostExchangeObservation {
  readonly principal: { readonly principalId: string };
  readonly envelope: RoomMessageEnvelope;
  readonly result: RoomPostResult;
  readonly childPid: number;
  readonly requestHash: string;
  readonly childRequestHash: string;
}

export interface GroupChatHostDriverOptions {
  /** Test-only observation of the exact post payload and result exchanged with the child host. */
  readonly onPostExchange?: (exchange: RoomPostExchangeObservation) => void;
}

type ResponseMessage =
  | { readonly kind: "ready"; readonly pid: number }
  | {
      readonly id: string;
      readonly ok: true;
      readonly value?: unknown;
      readonly hostPid: number;
      readonly requestHash: string;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: string;
      readonly hostPid: number;
      readonly requestHash: string;
    };

interface HostProcessExchange<T> {
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: T;
  readonly requestHash: string;
  readonly childRequestHash: string;
  readonly childPid: number;
}

interface PendingResponse {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestHash: string;
  readonly observe?: (exchange: HostProcessExchange<unknown>) => void;
}

class HostProcessClient {
  readonly #pending = new Map<string, PendingResponse>();
  readonly #ready: Promise<void>;
  readonly #stderrChunks: string[] = [];
  readonly #child: ChildProcess;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.#stderrChunks.push(chunk));
    child.on("message", (message: ResponseMessage) => this.#onMessage(message));
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => {
      const detail = `host exited ${String(code)}/${String(signal)}${this.#stderrChunks.join("")}`;
      this.#fail(new Error(detail));
    });
  }

  get pid(): number {
    if (this.#child.pid === undefined) throw new Error("host process has no pid");
    return this.#child.pid;
  }

  async waitReady(): Promise<void> {
    await this.#ready;
  }

  async request<T>(
    kind: string,
    fields: Record<string, unknown> = {},
    observe?: (exchange: HostProcessExchange<T>) => void,
  ): Promise<T> {
    await this.#ready;
    const id = randomUUID();
    const request = JSON.parse(JSON.stringify({ kind, ...fields })) as Record<string, unknown>;
    const requestHash = hashRequest(request);
    const response = new Promise<unknown>((resolve, reject) => {
      const pending: PendingResponse = {
        resolve,
        reject,
        request,
        requestHash,
        ...(observe === undefined
          ? {}
          : {
              observe: (exchange: HostProcessExchange<unknown>) =>
                observe(exchange as HostProcessExchange<T>),
            }),
      };
      this.#pending.set(id, pending);
    });
    this.#child.send({ id, ...request, requestHash }, (error) => {
      if (error !== null) {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(error);
      }
    });
    return (await response) as T;
  }

  waitForExit(): Promise<void> {
    if (this.#child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#child.once("exit", (code, signal) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`host exited ${String(code)}/${String(signal)}`));
      });
    });
  }

  terminate(): void {
    if (this.#child.exitCode === null) this.#child.kill();
  }

  #onMessage(message: ResponseMessage): void {
    if ("kind" in message && message.kind === "ready") {
      this.#resolveReady();
      return;
    }
    if (!("id" in message)) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (pending.observe !== undefined) {
      if (message.hostPid !== this.pid || message.requestHash !== pending.requestHash) {
        pending.reject(new Error("group-chat host IPC receipt did not match the sent request"));
        return;
      }
      if (message.ok) {
        pending.observe({
          request: pending.request,
          response: message.value,
          requestHash: pending.requestHash,
          childRequestHash: message.requestHash,
          childPid: message.hostPid,
        });
      }
    }
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error));
  }

  #fail(error: Error): void {
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

type FixtureWithTrustedBinding = Omit<typeof groupChatSyntheticFixture, "trustedOwnerBinding"> & {
  readonly trustedOwnerBinding?: unknown;
};

/** Real child-process adapter for the durable room-write slice; unsupported lamps fail explicitly. */
export function createGroupChatHostDriver(
  options: GroupChatHostDriverOptions = {},
): GroupChatHostDriver & {
  restartHost(): Promise<GroupChatHostRun>;
} {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const hostEntry = fileURLToPath(new URL("./group-chat/host-process.ts", import.meta.url));
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "mist-group-chat-")));
  let client: HostProcessClient | null = null;
  process.once("exit", () => rmSync(dataRoot, { recursive: true, force: true }));

  const startHost = async (): Promise<GroupChatHostRun> => {
    if (client !== null) throw new Error("group-chat host is already running");
    const child = fork(hostEntry, [], {
      cwd: repositoryRoot,
      execPath: process.execPath,
      execArgv: ["--import", "tsx"],
      env: { ...process.env, MIST_GROUP_CHAT_DATA_ROOT: dataRoot },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const started = new HostProcessClient(child);
    client = started;
    try {
      await started.waitReady();
    } catch (error) {
      client = null;
      child.kill();
      await started.waitForExit();
      throw error;
    }
    const run = {
      pid: started.pid,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
      dataRoot,
    };
    return run;
  };

  const stopHost = async (): Promise<void> => {
    const current = client;
    if (current === null) return;
    client = null;
    try {
      await current.request("shutdown");
    } catch (error) {
      current.terminate();
      await current.waitForExit();
      throw error;
    }
    await current.waitForExit();
  };

  const active = (): HostProcessClient => {
    if (client === null) throw new Error("group-chat host is not running");
    return client;
  };

  return {
    kind: "mist-host",
    startHost,
    restartHost: async () => {
      if (client !== null) await stopHost();
      return startHost();
    },
    stopHost,
    resetScenario: async (_id: GroupChatCheckId, fixture: FixtureWithTrustedBinding) => {
      const trustedBinding = fixture.trustedOwnerBinding;
      const grants: RoomBindingGrant[] =
        typeof trustedBinding === "string"
          ? [fixture.humanId, fixture.residentIds.a].map((principalId) => ({
              principalId,
              roomId: fixture.roomId,
              bindingId: trustedBinding,
            }))
          : [];
      await active().request("reset", {
        grants,
        roomId: fixture.roomId,
        residentIds: [fixture.residentIds.a, fixture.residentIds.b],
      });
    },
    perform: async (command: GroupChatCommand) => {
      switch (command.kind) {
        case "post": {
          const { kind: _kind, ...rawFields } = command;
          void _kind;
          const envelope = { ...rawFields, operationId: randomUUID() } as RoomMessageEnvelope;
          const principal = { principalId: command.principalId };
          await active().request<RoomPostResult>("post", { principal, envelope }, (exchange) => {
            options.onPostExchange?.({
              principal: exchange.request.principal as { readonly principalId: string },
              envelope: exchange.request.envelope as RoomMessageEnvelope,
              result: exchange.response,
              childPid: exchange.childPid,
              requestHash: exchange.requestHash,
              childRequestHash: exchange.childRequestHash,
            });
          });
          return;
        }
        case "seed-resident-private":
          await active().request("seed-resident-private", command);
          return;
        case "save-memory":
          await active().request("save-memory", command);
          return;
        case "set-delivery-state":
          await active().request("set-delivery-state", command);
          return;
        case "register-resident":
          await active().request("register-resident", command);
          return;
        case "exercise-roster-path":
          await active().request("exercise-roster-path", command);
          return;
        case "record-event":
          await active().request("record-event", command);
          return;
        case "dispatch-event":
          await active().request("dispatch-event", command);
          return;
        case "commit-context":
          await active().request("commit-context", command);
          return;
        case "react":
          await active().request("react", command);
          return;
        default:
          throw new Error(`unsupported group-chat host command: ${command.kind}`);
      }
    },
    readRoomEvents: async (roomId?: string) => {
      const rows = await active().request<readonly RoomEvent[]>("read-room-events", { roomId });
      return rows.map(toAcceptanceRoomEvent);
    },
    readSystemReceipts: async () => {
      const rows =
        await active().request<readonly (SystemReceipt & { readonly roomEventId: string })[]>(
          "read-system-receipts",
        );
      return rows.map(({ roomEventId: _roomEventId, ...receipt }) => {
        void _roomEventId;
        return receipt;
      });
    },
    readDeliveries: (eventId: string) =>
      active().request<readonly DeliveryRecord[]>("read-deliveries", { eventId }),
    readMemories: async () => {
      const memories = await active().request<readonly ResidentMemory[]>("read-memories");
      return memories.map(
        ({ residentId, sourceEventId, body }): MemoryRecord => ({
          residentId: residentId as MemoryRecord["residentId"],
          sourceEventId,
          body,
        }),
      );
    },
    readResidentContext: (residentId: string) =>
      active().request<string>("read-resident-context", { residentId }),
    readRoster: () => active().request<RosterSnapshot>("read-roster"),
    readRosterPath: (path) => active().request<RosterProjection>("read-roster-path", { path }),
    readMentionDecisions: unsupported("readMentionDecisions"),
    readCallLedger: unsupported("readCallLedger"),
    readContextCommits: () => active().request<readonly ContextCommit[]>("read-context-commits"),
    readSurface: (roomId, viewerId) =>
      active().request<SurfaceSnapshot>("read-surface", { roomId, viewerId }),
    readAccessAudit: unsupported("readAccessAudit"),
    readReactions: () => active().request<readonly ResidentReaction[]>("read-reactions"),
    readRoundRecords: unsupported("readRoundRecords"),
    readScheduler: unsupported("readScheduler"),
    readControlRecords: unsupported("readControlRecords"),
    readDeliveryDecisions: unsupported("readDeliveryDecisions"),
    readSenderFeedback: unsupported("readSenderFeedback"),
    readProjectionReceipts: unsupported("readProjectionReceipts"),
    readProjectionContext: unsupported("readProjectionContext"),
    readSourceReads: unsupported("readSourceReads"),
    readMemberAttempts: unsupported("readMemberAttempts"),
    readMemberResults: unsupported("readMemberResults"),
  };
}

function toAcceptanceRoomEvent(event: RoomEvent): AcceptanceRoomEvent {
  return {
    id: event.id,
    roomId: event.roomId,
    position: event.position,
    authorId: event.authorId,
    body: event.body,
    visibility: event.visibility,
  };
}

function unsupported<T>(operation: string): (...args: never[]) => Promise<T> {
  return async () => {
    throw new Error(`group-chat host does not implement ${operation}`);
  };
}

function hashRequest(request: Readonly<Record<string, unknown>>): string {
  const serialized = JSON.stringify(request);
  if (serialized === undefined) throw new Error("group-chat host request is not serializable");
  return createHash("sha256").update(serialized).digest("hex");
}
