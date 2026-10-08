import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FrontendChatRequest,
  FrontendRequestContext,
  ResidentReply,
} from "../acceptance/frontend-adapter-driver.ts";
import { DeferredStructureEngine } from "../src/frontend/deferred-structure-engine.ts";
import type {
  FrontendModelPort,
  FrontendModelTurn,
} from "../src/frontend/deferred-structure-engine.ts";
import {
  FrontendModelPortStructureUnsupportedError,
  createTransportModelPort,
} from "../src/frontend/transport-model-port.ts";
import { CanonicalStreamStore } from "../src/one-stream/index.ts";
import type { CanonicalEventDraft } from "../src/one-stream/index.ts";
import { SyntheticModelTransport } from "../src/resident-runtime/channels.ts";
import { openCanonicalStreamWriter } from "../src/window-host/window-history-host.ts";

const temporaryDirectories: string[] = [];
function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-frontend-engine-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class QueuePort implements FrontendModelPort {
  readonly #queues = new Map<string, ResidentReply[]>();
  readonly received: Array<{ attachments: number; capabilities: string[]; currentText: string }> =
    [];
  enqueue(bindingId: string, reply: ResidentReply): void {
    const queue = this.#queues.get(bindingId) ?? [];
    queue.push(structuredClone(reply));
    this.#queues.set(bindingId, queue);
  }
  async complete(turn: FrontendModelTurn): Promise<ResidentReply> {
    this.received.push({
      attachments: turn.attachments.length,
      capabilities: [...turn.surfaceCapabilities],
      currentText: turn.currentText,
    });
    const reply = this.#queues.get(turn.bindingId)?.shift();
    if (reply === undefined) throw new Error("no queued reply");
    if (reply.kind === "attachment") {
      return {
        kind: "attachment",
        text: reply.text,
        attachments: reply.attachments.map((attachment) =>
          turn.attachmentPort.prepareOutbound({
            kind: attachment.kind,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            bytes: Buffer.alloc(attachment.sizeBytes, 0x20),
          }),
        ),
      };
    }
    return structuredClone(reply);
  }
}

function context(token: string): FrontendRequestContext {
  return { token, source: "remote", conversationId: null };
}

function request(
  text: string,
  content?: FrontendChatRequest["messages"][number]["content"],
  capabilities: Array<"attachments" | "interactions"> = [],
): FrontendChatRequest {
  return {
    model: "client-model",
    stream: false,
    messages: [{ role: "user", content: content ?? text }],
    mist: { client: { surface: "test", capabilities } },
  };
}

function hostDraft(
  residentId: string,
  role: "user" | "assistant",
  text: string,
): CanonicalEventDraft {
  return {
    purpose: "message",
    occurredAt: new Date().toISOString(),
    workRef: null,
    authoritySource: { kind: "resident", id: residentId },
    origin: {
      reporter: { kind: "resident", id: residentId },
      subject: { kind: "resident", id: residentId },
      viewport: { windowId: "host-window", generation: 1 },
    },
    effect: { state: "not-applicable", requiresUserAction: false, retry: "not-applicable" },
    artifactRef: null,
    payload: { role, text },
  };
}

describe("#218 engine reads/writes the resident's real canonical stream", () => {
  it("lets a second binding for the same resident see the first binding's history", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const first = await engine.provisionBinding({
      residentId: "resident-shared",
      scopeId: "scope:one",
      label: "a",
    });
    await engine.seedCanonicalHistory(first.bindingId, ["h:user", "h:assistant"]);
    const second = await engine.provisionBinding({
      residentId: "resident-shared",
      scopeId: "scope:one",
      label: "b",
    });
    const events = await engine.readCanonicalEvents(second.bindingId);
    expect(events.map((event) => event.text)).toEqual(["h:user", "h:assistant"]);
    expect(events[0]?.residentId).toBe("resident-shared");
    expect(second.streamId).toBe(first.streamId);
    expect(second.canonicalWriterId).toBe(first.canonicalWriterId);
    await engine.close();
  });

  it("reads existing host user/assistant events by their real residentId", async () => {
    const port = new QueuePort();
    const store = new CanonicalStreamStore();
    store.createStream("real-resident-218");
    const writer = openCanonicalStreamWriter(store);
    await writer.submit({
      residentId: "real-resident-218",
      idempotencyKey: randomUUID(),
      draft: hostDraft("real-resident-218", "user", "host:hello"),
    });
    await writer.submit({
      residentId: "real-resident-218",
      idempotencyKey: randomUUID(),
      draft: hostDraft("real-resident-218", "assistant", "host:reply"),
    });

    // 借宿主已打开的 store+writer：不新开第二个写方，不抢 owner。
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port, streamStore: store, writer },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "real-resident-218",
      scopeId: "scope:host",
      label: "host",
    });
    const events = await engine.readCanonicalEvents(binding.bindingId);
    expect(events.map((event) => [event.residentId, event.kind, event.text])).toEqual([
      ["real-resident-218", "user", "host:hello"],
      ["real-resident-218", "assistant", "host:reply"],
    ]);

    // 模型历史必须来自这条真实主流。
    port.enqueue(binding.bindingId, { kind: "text", text: "engine-reply" });
    await engine.handle(binding.bindingId, context(binding.token), request("engine:turn"));
    const turns = await engine.readModelTurns(binding.bindingId);
    expect(turns.at(-1)?.canonicalHistoryText).toEqual(["host:hello", "host:reply"]);

    // 前端写的事件，宿主按 message 形状（role/text）看得到。
    const hostView = store
      .events("real-resident-218")
      .filter((event) => event.payload.role === "user" || event.payload.role === "assistant")
      .map((event) => event.payload.text ?? null);
    expect(hostView).toContain("engine:turn");
    expect(hostView).toContain("engine-reply");
    await engine.close();
    await writer.close();
  });

  it("reopens a persistent dataDir and accepts a new turn without idempotency collision", async () => {
    const dataDir = freshDirectory();
    const port = new QueuePort();
    const open = () =>
      new DeferredStructureEngine(
        {
          textOnly: false,
          modelPort: port,
          storeFactory: () => new CanonicalStreamStore({ dataDir }),
        },
        freshDirectory(),
      );
    const first = open();
    const a = await first.provisionBinding({
      residentId: "resident-persist",
      scopeId: "scope:p",
      label: "p1",
    });
    await first.seedCanonicalHistory(a.bindingId, ["p:user", "p:assistant"]);
    port.enqueue(a.bindingId, { kind: "text", text: "first" });
    expect(
      (await first.handle(a.bindingId, context(a.token), request("one"))).response.status,
    ).toBe(200);
    await first.close();

    const second = open();
    const b = await second.provisionBinding({
      residentId: "resident-persist",
      scopeId: "scope:p",
      label: "p2",
    });
    port.enqueue(b.bindingId, { kind: "text", text: "second" });
    const result = await second.handle(b.bindingId, context(b.token), request("two"));
    expect(result.response.status).toBe(200);
    expect(result.response.body?.text).toBe("second");
    await second.close();
  });
});

describe("#218 engine fails explicitly without a model port", () => {
  it("returns 503 and writes zero canonical/attachment state", async () => {
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: null },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-nomodel",
      scopeId: "scope:n",
      label: "n",
    });
    const content = [
      { type: "text" as const, text: "hi" },
      { type: "file" as const, file: { filename: "in.txt", file_data: "aGVsbG8=" } },
    ];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("hi", content),
    );
    expect(response.status).toBe(503);
    expect(response.error?.code).toBe("MIST_MODEL_UNAVAILABLE");
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });
});

describe("#218 engine validates untrusted content before writing", () => {
  async function scenario(maxAttachmentBytes?: number) {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      maxAttachmentBytes === undefined
        ? { textOnly: false, modelPort: port }
        : { textOnly: false, modelPort: port, maxAttachmentBytes },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-validate",
      scopeId: "scope:v",
      label: "v",
    });
    return { engine, binding, port };
  }

  it("returns a stable 400 for a file part without file_data/file_id (no throw)", async () => {
    const { engine, binding } = await scenario();
    const content = [
      { type: "file" as const, file: { filename: "x" } },
    ] as unknown as FrontendChatRequest["messages"][number]["content"];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x", content),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_INVALID_TURN_SHAPE");
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("rejects an unknown opaque file_id instead of minting a reference", async () => {
    const { engine, binding } = await scenario();
    const content = [
      { type: "file" as const, file: { filename: "x.txt", file_id: "att_does_not_exist" } },
    ];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x", content),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_ATTACHMENT_REF_INVALID");
    await engine.close();
  });

  it("rejects malformed base64 with a stable 400", async () => {
    const { engine, binding } = await scenario();
    const content = [
      { type: "file" as const, file: { filename: "x.txt", file_data: "!!!not-base64!!!" } },
    ];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x", content),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_INVALID_TURN_SHAPE");
    await engine.close();
  });

  it("rejects an unsupported image media declaration (data:text/html) with zero side effects", async () => {
    const { engine, binding } = await scenario();
    const content = [
      {
        type: "image_url" as const,
        image_url: { url: "data:text/html;base64,aGVsbG8=" },
      },
    ];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x", content),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_ATTACHMENT_MEDIA_UNSUPPORTED");
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("rejects image/png bytes that are not actually PNG", async () => {
    const { engine, binding } = await scenario();
    const content = [
      {
        type: "image_url" as const,
        image_url: { url: "data:image/png;base64,aGVsbG8=" },
      },
    ];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x", content),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_ATTACHMENT_MEDIA_UNSUPPORTED");
    await engine.close();
  });

  it("accepts a real PNG data URL", async () => {
    const { engine, binding, port } = await scenario();
    port.enqueue(binding.bindingId, { kind: "text", text: "ok" });
    // 1x1 PNG.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";
    const content = [
      { type: "image_url" as const, image_url: { url: `data:image/png;base64,${png}` } },
    ];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x", content),
    );
    expect(response.status).toBe(200);
    const writes = await engine.readAttachmentWrites();
    expect(writes.records[0]?.kind).toBe("image");
    expect(writes.records[0]?.mediaType).toBe("image/png");
    await engine.close();
  });

  it("rejects an attachment above the configured limit with zero side effects", async () => {
    const { engine, binding, port } = await scenario(4);
    port.enqueue(binding.bindingId, { kind: "text", text: "should not run" });
    const content = [
      {
        type: "file" as const,
        file: { filename: "x.txt", file_data: Buffer.from("hello world").toString("base64") },
      },
    ];
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x", content),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_ATTACHMENT_LIMIT_EXCEEDED");
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("rejects a cross-binding opaque reference", async () => {
    const { engine, binding, port } = await scenario();
    port.enqueue(binding.bindingId, { kind: "text", text: "ok" });
    await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("first", [
        { type: "text", text: "first" },
        { type: "file", file: { filename: "shared.txt", file_data: "aGVsbG8=" } },
      ]),
    );
    const stored = (await engine.readAttachmentWrites()).records[0];
    if (stored === undefined) throw new Error("expected an inbound attachment write");

    const other = await engine.provisionBinding({
      residentId: "resident-other",
      scopeId: "scope:o",
      label: "o",
    });
    const { response } = await engine.handle(
      other.bindingId,
      context(other.token),
      request("steal", [
        { type: "file", file: { filename: "shared.txt", file_id: stored.attachmentId } },
      ]),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_ATTACHMENT_REF_INVALID");
    await engine.close();
  });

  it("accepts a well-formed inline attachment and records exactly the inbound write", async () => {
    const { engine, binding, port } = await scenario();
    port.enqueue(binding.bindingId, { kind: "text", text: "ok" });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("legal", [
        { type: "text", text: "legal" },
        { type: "file", file: { filename: "legal.txt", file_data: "aGVsbG8=" } },
      ]),
    );
    expect(response.status).toBe(200);
    const writes = await engine.readAttachmentWrites();
    expect(writes.count).toBe(1);
    expect(writes.records[0]?.filename).toBe("legal.txt");
    await engine.close();
  });
});

describe("#218 engine carries attachments/capabilities to the model port and signs outbound refs", () => {
  it("delivers attachments and surface capabilities to the model port", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-deliver",
      scopeId: "scope:d",
      label: "d",
    });
    port.enqueue(binding.bindingId, { kind: "text", text: "ok" });
    await engine.handle(
      binding.bindingId,
      context(binding.token),
      request(
        "with attachment",
        [
          { type: "text", text: "with attachment" },
          { type: "file", file: { filename: "a.txt", file_data: "aGVsbG8=" } },
        ],
        ["attachments"],
      ),
    );
    expect(port.received.at(-1)).toEqual({
      attachments: 1,
      capabilities: ["attachments"],
      currentText: "with attachment",
    });
    await engine.close();
  });

  it("rejects a model port that returns an unissued outbound attachment", async () => {
    const forgedPort = {
      complete: async (): Promise<ResidentReply> => ({
        kind: "attachment",
        text: "forged",
        attachments: [
          {
            attachmentId: "arbitrary-unissued-ref",
            kind: "file",
            filename: "f.txt",
            mediaType: "text/plain",
            sizeBytes: 5,
            source: "inline",
          },
        ],
      }),
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: forgedPort },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-forged",
      scopeId: "scope:f",
      label: "f",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("hi"),
    );
    expect(response.status).toBe(502);
    expect(response.error?.code).toBe("MIST_MODEL_REPLY_INVALID");
    await engine.close();
  });
});

describe("#218 engine checks the current generation for control", () => {
  it("rejects a pending interaction after a generation bump with zero side effects", async () => {
    let generation = 1;
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port, resolveGeneration: () => generation },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-gen",
      scopeId: "scope:g",
      label: "g",
    });
    const interaction = {
      interactionId: "interaction:gen",
      kind: "approval" as const,
      prompt: "Approve?",
      blocking: true as const,
      options: [{ optionId: "yes", label: "Yes", description: null }],
      reasonCode: null,
    };
    port.enqueue(binding.bindingId, { kind: "interaction", text: "approve?", interaction });
    await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("start", undefined, ["interactions"]),
    );
    const before = await engine.readCanonicalEvents(binding.bindingId);

    generation = 2;
    const { response } = await engine.handle(binding.bindingId, context(binding.token), {
      model: "m",
      stream: false,
      messages: [],
      mist: {
        client: { surface: "test", capabilities: ["interactions"] },
        interactionResponse: { interactionId: interaction.interactionId, optionId: "yes" },
      },
    });
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_INTERACTION_RESPONSE_INVALID");
    expect((await engine.readCanonicalEvents(binding.bindingId)).length).toBe(before.length);
    const readback = (await engine.readInteractions(binding.bindingId)).find(
      (item) => item.interactionId === interaction.interactionId,
    );
    expect(readback?.status).toBe("pending");
    await engine.close();
  });
});

describe("#218 engine consumes each interaction exactly once", () => {
  it("allows exactly one resolution under parallel identical clicks", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-click",
      scopeId: "scope:c",
      label: "c",
    });
    const interaction = {
      interactionId: "interaction:parallel",
      kind: "choice" as const,
      prompt: "Pick",
      blocking: true as const,
      options: [
        { optionId: "a", label: "A", description: null },
        { optionId: "b", label: "B", description: null },
      ],
      reasonCode: null,
    };
    port.enqueue(binding.bindingId, { kind: "interaction", text: "pick", interaction });
    await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("start", undefined, ["interactions"]),
    );
    const click: FrontendChatRequest = {
      model: "m",
      stream: false,
      messages: [],
      mist: {
        client: { surface: "test", capabilities: ["interactions"] },
        interactionResponse: { interactionId: interaction.interactionId, optionId: "a" },
      },
    };
    const [first, second] = await Promise.all([
      engine.handle(binding.bindingId, context(binding.token), click),
      engine.handle(binding.bindingId, context(binding.token), click),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 400]);
    const events = await engine.readCanonicalEvents(binding.bindingId);
    const resolutions = events.filter(
      (event) =>
        event.kind === "interaction" &&
        event.interaction?.interactionId === interaction.interactionId &&
        event.resolvedOptionId === "a",
    );
    expect(resolutions.length).toBe(1);
    await engine.close();
  });
});

describe("#218 engine bridges the existing resident model transport", () => {
  it("runs the real SyntheticModelTransport for text-only turns (no placeholder)", async () => {
    const port = createTransportModelPort(new SyntheticModelTransport(), {
      resolveCompletion: (turn) => ({
        adapterId: "pi-ai",
        model: "pi-test-model",
        bootPack: {
          residentId: turn.residentId,
          identity: `persona:${turn.residentId}`,
          commitments: [],
          memories: [],
        },
        credentialSecret: "synthetic-secret",
      }),
    });
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-transport",
      scopeId: "scope:t",
      label: "t",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("hello there"),
    );
    expect(response.status).toBe(200);
    expect(response.body?.text).toContain("合成回声已读来信。");
    await engine.close();
  });

  it("fails explicitly rather than silently dropping attachments on the text-only bridge", async () => {
    const port = createTransportModelPort(new SyntheticModelTransport(), {
      resolveCompletion: (turn) => ({
        adapterId: "pi-ai",
        model: "pi-test-model",
        bootPack: {
          residentId: turn.residentId,
          identity: `persona:${turn.residentId}`,
          commitments: [],
          memories: [],
        },
        credentialSecret: "synthetic-secret",
      }),
    });
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-transport2",
      scopeId: "scope:t2",
      label: "t2",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request(
        "with attachment",
        [
          { type: "text", text: "with attachment" },
          { type: "file", file: { filename: "a.txt", file_data: "aGVsbG8=" } },
        ],
        ["attachments"],
      ),
    );
    expect(response.status).toBe(502);
    expect(response.error?.code).toBe("MIST_MODEL_FAILED");
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
    expect(new FrontendModelPortStructureUnsupportedError("x").code).toBe(
      "FRONTEND_MODEL_PORT_STRUCTURE_UNSUPPORTED",
    );
  });
});

describe("#218 engine real private attachment port", () => {
  it("lets the model port read this turn's inbound bytes", async () => {
    const captured: Buffer[] = [];
    const readingPort: FrontendModelPort = {
      async complete(turn) {
        const incoming = turn.attachmentPort.incoming();
        if (incoming[0] !== undefined) captured.push(await incoming[0].read());
        return { kind: "text", text: "ok" };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: readingPort },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-read",
      scopeId: "scope:r",
      label: "r",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("in", [
        { type: "text", text: "in" },
        { type: "file", file: { filename: "in.txt", file_data: "aGVsbG8=" } },
      ]),
    );
    expect(response.status).toBe(200);
    expect(captured[0]?.equals(Buffer.from("hello"))).toBe(true);
    await engine.close();
  });

  it("lets the model port open a legal existing ref and read its bytes", async () => {
    let targetId: string | null = null;
    const captured: Buffer[] = [];
    const readingPort: FrontendModelPort = {
      async complete(turn) {
        if (targetId !== null) {
          const handle = turn.attachmentPort.open(targetId);
          if (handle !== null) captured.push(await handle.read());
        }
        return { kind: "text", text: "ok" };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: readingPort },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-open",
      scopeId: "scope:o",
      label: "o",
    });
    await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("first", [
        { type: "text", text: "first" },
        { type: "file", file: { filename: "s.txt", file_data: "aGVsbG8=" } },
      ]),
    );
    targetId = (await engine.readAttachmentWrites()).records[0]?.attachmentId ?? null;
    await engine.handle(binding.bindingId, context(binding.token), request("second"));
    expect(captured[0]?.equals(Buffer.from("hello"))).toBe(true);
    await engine.close();
  });

  it("commits a host-signed outbound attachment with its real bytes", async () => {
    const outboundPort: FrontendModelPort = {
      async complete(turn) {
        const attachment = turn.attachmentPort.prepareOutbound({
          kind: "file",
          filename: "out.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("outbound-bytes"),
        });
        return { kind: "attachment", text: "here", attachments: [attachment] };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: outboundPort },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-out",
      scopeId: "scope:out",
      label: "out",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("give"),
    );
    expect(response.status).toBe(200);
    const writes = await engine.readAttachmentWrites();
    expect(writes.count).toBe(1);
    expect(writes.records[0]?.filename).toBe("out.txt");
    expect(writes.records[0]?.sizeBytes).toBe("outbound-bytes".length);
    await engine.close();
  });

  it("discards staged outbound attachments when the model port throws", async () => {
    const throwingPort: FrontendModelPort = {
      async complete(turn) {
        turn.attachmentPort.prepareOutbound({
          kind: "file",
          filename: "x.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("abc"),
        });
        throw new Error("model blew up");
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: throwingPort },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-throw",
      scopeId: "scope:th",
      label: "th",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("hi"),
    );
    expect(response.status).toBe(502);
    expect(response.error?.code).toBe("MIST_MODEL_FAILED");
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
    await engine.close();
  });

  it("rejects reusing an existing ref with mismatched bytes", async () => {
    let created = false;
    const port: FrontendModelPort = {
      async complete(turn) {
        if (!created) {
          created = true;
          const attachment = turn.attachmentPort.prepareOutbound({
            kind: "file",
            filename: "a.txt",
            mediaType: "text/plain",
            bytes: Buffer.from("aaaa"),
          });
          return { kind: "attachment", text: "first", attachments: [attachment] };
        }
        // 复用同 ID 但字节不符：必须被拒，不能铸授权。
        turn.attachmentPort.reuseOutbound("out-existing", {
          kind: "file",
          filename: "a.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("bbbb"),
        });
        return { kind: "text", text: "second" };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port, newOutboundAttachmentId: () => "out-existing" },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-forge2",
      scopeId: "scope:f2",
      label: "f2",
    });
    await engine.handle(binding.bindingId, context(binding.token), request("one"));
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("two"),
    );
    expect(response.status).toBe(502);
    expect((await engine.readAttachmentWrites()).count).toBe(1);
    await engine.close();
  });
});

describe("#218 engine authentication cannot be bypassed", () => {
  it("rejects a direct unauthenticated turn with 401 and zero side effects", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-auth",
      scopeId: "scope:au",
      label: "au",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      { token: null, source: "loopback", conversationId: null },
      request("hi"),
    );
    expect(response.status).toBe(401);
    expect(response.error?.code).toBe("AUTH_REQUIRED");
    expect((await engine.readModelTurns(binding.bindingId)).length).toBe(0);
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    const audit = await engine.readSecurityAudit();
    expect(audit.attempts).toBe(1);
    expect(audit.entries[0]).toEqual({
      source: "loopback",
      result: "rejected",
      code: "AUTH_REQUIRED",
    });
    await engine.close();
  });

  it("rejects a forged grant object and never processes the turn", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-forge",
      scopeId: "scope:fg",
      label: "fg",
    });
    port.enqueue(binding.bindingId, { kind: "text", text: "should not run" });
    const { response } = await engine.execute({ bindingId: binding.bindingId }, request("forged"));
    expect(response.status).toBe(401);
    expect((await engine.readModelTurns(binding.bindingId)).length).toBe(0);
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
    await engine.close();
  });

  it("issues a single-use grant bound to the authenticated binding", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-grant",
      scopeId: "scope:gr",
      label: "gr",
    });
    const auth = engine.authenticate(binding.bindingId, {
      token: binding.token,
      source: "remote",
      conversationId: null,
    });
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("expected a grant");
    port.enqueue(binding.bindingId, { kind: "text", text: "first" });
    const first = await engine.execute(auth.grant, request("one"));
    expect(first.response.status).toBe(200);
    // 同一张凭据不可复用。
    const second = await engine.execute(auth.grant, request("two"));
    expect(second.response.status).toBe(401);
    await engine.close();
  });
});

describe("#218 engine grants cannot be rebound or forged", () => {
  it("never executes a different binding when grant fields are tampered with", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const a = await engine.provisionBinding({
      residentId: "resident-a",
      scopeId: "scope:a",
      label: "a",
    });
    const b = await engine.provisionBinding({
      residentId: "resident-b",
      scopeId: "scope:b",
      label: "b",
    });
    const auth = engine.authenticate(a.bindingId, context(a.token));
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("expected grant");
    // 冻结对象不可写；即便试图改绑也抛错，不能指向 B。
    expect(() => {
      (auth.grant as { bindingId?: string }).bindingId = b.bindingId;
    }).toThrow();
    port.enqueue(a.bindingId, { kind: "text", text: "for-a" });
    const result = await engine.execute(auth.grant, request("turn"));
    expect(result.response.status).toBe(200);
    expect(result.response.body?.text).toBe("for-a");
    const aText = (await engine.readCanonicalEvents(a.bindingId))
      .filter((event) => event.kind === "assistant")
      .map((event) => event.text);
    expect(aText).toEqual(["for-a"]);
    expect(await engine.readCanonicalEvents(b.bindingId)).toEqual([]);
    await engine.close();
  });

  it("rejects a cloned or foreign-engine grant", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const other = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-clone",
      scopeId: "scope:c",
      label: "c",
    });
    const auth = engine.authenticate(binding.bindingId, context(binding.token));
    if (!auth.ok) throw new Error("expected grant");
    const cloned = structuredClone(auth.grant);
    const foreign = other.authenticate(binding.bindingId, context(binding.token));
    port.enqueue(binding.bindingId, { kind: "text", text: "x" });
    expect((await engine.execute(cloned, request("c"))).response.status).toBe(401);
    expect(
      (await engine.execute(foreign.ok ? foreign.grant : {}, request("f"))).response.status,
    ).toBe(401);
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
    await engine.close();
    await other.close();
  });
});

describe("#218 private attachment boundary is enforced", () => {
  it("rejects an unsafe host-generated outbound id with zero out-of-bounds effects", async () => {
    const root = freshDirectory();
    const port: FrontendModelPort = {
      async complete(turn) {
        const attachment = turn.attachmentPort.prepareOutbound({
          kind: "file",
          filename: "test.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("synthetic bytes"),
        });
        return { kind: "attachment", text: "x", attachments: [attachment] };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port, newOutboundAttachmentId: () => "../outside-attachments" },
      root,
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-traverse",
      scopeId: "scope:t",
      label: "t",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x"),
    );
    expect(response.status).toBe(502);
    expect(existsSync(join(root, "outside-attachments.bin"))).toBe(false);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("issues host-generated opaque outbound ids by default", async () => {
    const port: FrontendModelPort = {
      async complete(turn) {
        const attachment = turn.attachmentPort.prepareOutbound({
          kind: "file",
          filename: "o.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("bytes"),
        });
        return { kind: "attachment", text: "x", attachments: [attachment] };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-gen",
      scopeId: "scope:g",
      label: "g",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x"),
    );
    expect(response.status).toBe(200);
    expect(response.body?.attachments[0]?.attachmentId.startsWith("att_")).toBe(true);
    await engine.close();
  });

  it("rejects reusing an unknown ref instead of minting a new file", async () => {
    const port: FrontendModelPort = {
      async complete(turn) {
        turn.attachmentPort.reuseOutbound("nope-not-issued", {
          kind: "file",
          filename: "x.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("abc"),
        });
        return { kind: "text", text: "ok" };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-unknown",
      scopeId: "scope:u",
      label: "u",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x"),
    );
    expect(response.status).toBe(502);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("rejects forged metadata for a staged attachment id", async () => {
    const port: FrontendModelPort = {
      async complete(turn) {
        const prepared = turn.attachmentPort.prepareOutbound({
          kind: "file",
          filename: "f.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("abcd"),
        });
        return {
          kind: "attachment",
          text: "x",
          attachments: [{ ...prepared, sizeBytes: 42 }],
        };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-meta",
      scopeId: "scope:m",
      label: "m",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("x"),
    );
    expect(response.status).toBe(502);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("does not let a later turn use a discarded stage from another turn", async () => {
    let turn = 0;
    const port: FrontendModelPort = {
      async complete(current) {
        turn += 1;
        if (turn === 1) {
          current.attachmentPort.prepareOutbound({
            kind: "file",
            filename: "x.txt",
            mediaType: "text/plain",
            bytes: Buffer.from("abc"),
          });
          throw new Error("first turn fails");
        }
        return {
          kind: "attachment",
          text: "bad",
          attachments: [
            {
              attachmentId: "stage-leftover",
              kind: "file",
              filename: "x.txt",
              mediaType: "text/plain",
              sizeBytes: 3,
              source: "inline",
            },
          ],
        };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port, newOutboundAttachmentId: () => "stage-leftover" },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-stage",
      scopeId: "scope:s",
      label: "s",
    });
    expect(
      (await engine.handle(binding.bindingId, context(binding.token), request("one"))).response
        .status,
    ).toBe(502);
    expect(
      (await engine.handle(binding.bindingId, context(binding.token), request("two"))).response
        .status,
    ).toBe(502);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("snapshots staged bytes and returns read copies", async () => {
    const original = Buffer.from("original-bytes");
    let first = true;
    let refId = "";
    const port: FrontendModelPort = {
      async complete(turn) {
        if (first) {
          first = false;
          const prepared = turn.attachmentPort.prepareOutbound({
            kind: "file",
            filename: "s.txt",
            mediaType: "text/plain",
            bytes: original,
          });
          refId = prepared.attachmentId;
          original.fill(0); // 校验后再改原 Buffer，不得影响已存快照
          return { kind: "attachment", text: "x", attachments: [prepared] };
        }
        const readOnce = await turn.attachmentPort.open(refId)?.read();
        readOnce?.fill(0);
        const readTwice = await turn.attachmentPort.open(refId)?.read();
        expect(readTwice?.toString("utf8")).toBe("original-bytes");
        return { kind: "text", text: "ok" };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port, newOutboundAttachmentId: () => "snapshot-ref" },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-snap",
      scopeId: "scope:sn",
      label: "sn",
    });
    expect(
      (await engine.handle(binding.bindingId, context(binding.token), request("one"))).response
        .status,
    ).toBe(200);
    expect(
      (await engine.handle(binding.bindingId, context(binding.token), request("two"))).response
        .status,
    ).toBe(200);
    await engine.close();
  });
  it("invalidates the attachment port after the turn ends", async () => {
    let captured: FrontendModelTurn["attachmentPort"] | null = null;
    const port: FrontendModelPort = {
      async complete(turn) {
        captured = turn.attachmentPort;
        return { kind: "text", text: "ok" };
      },
    };
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-closed",
      scopeId: "scope:cl",
      label: "cl",
    });
    await engine.handle(binding.bindingId, context(binding.token), request("x"));
    expect(() =>
      captured?.prepareOutbound({
        kind: "file",
        filename: "x.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("abc"),
      }),
    ).toThrow(/no longer active/);
    await engine.close();
  });
});

describe("#218 model history is scoped to the current generation", () => {
  it("keeps same-generation history and excludes prior-generation raw history", async () => {
    let generation = 1;
    const port = new QueuePort();
    const engine = new DeferredStructureEngine(
      { textOnly: false, modelPort: port, resolveGeneration: () => generation },
      freshDirectory(),
    );
    const binding = await engine.provisionBinding({
      residentId: "resident-gen2",
      scopeId: "scope:g2",
      label: "g2",
    });
    await engine.seedCanonicalHistory(binding.bindingId, ["g1:user", "g1:assistant"]);
    generation = 2;
    await engine.seedCanonicalHistory(binding.bindingId, ["g2:user", "g2:assistant"]);
    port.enqueue(binding.bindingId, { kind: "text", text: "reply" });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("turn"),
    );
    expect(response.status).toBe(200);
    const turns = await engine.readModelTurns(binding.bindingId);
    expect(turns.at(-1)?.canonicalHistoryText).toEqual(["g2:user", "g2:assistant"]);
    // 底层仍可读全部原件（含上一代）。
    const all = await engine.readCanonicalEvents(binding.bindingId);
    expect(all.filter((event) => event.kind === "user" || event.kind === "assistant").length).toBe(
      6,
    );
    await engine.close();
  });
});

describe("#218 default (product) engine is text-only host scope", () => {
  it("rejects structural requests before any model call/side effects", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine({ modelPort: port }, freshDirectory());
    const binding = await engine.provisionBinding({
      residentId: "resident-default",
      scopeId: "scope:def",
      label: "def",
    });
    const { response } = await engine.handle(
      binding.bindingId,
      context(binding.token),
      request("带文件", [
        { type: "text", text: "带文件" },
        { type: "file", file: { filename: "a.txt", file_data: "aGVsbG8=" } },
      ]),
    );
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_ATTACHMENT_UNSUPPORTED");
    expect(port.received.length).toBe(0);
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
    expect((await engine.readAttachmentWrites()).count).toBe(0);
    await engine.close();
  });

  it("rejects an interaction response with a stable code before any model call", async () => {
    const port = new QueuePort();
    const engine = new DeferredStructureEngine({ modelPort: port }, freshDirectory());
    const binding = await engine.provisionBinding({
      residentId: "resident-default2",
      scopeId: "scope:def2",
      label: "def2",
    });
    const { response } = await engine.handle(binding.bindingId, context(binding.token), {
      model: "m",
      stream: false,
      messages: [],
      mist: {
        client: { surface: "test", capabilities: [] },
        interactionResponse: { interactionId: "x", optionId: "y" },
      },
    });
    expect(response.status).toBe(400);
    expect(response.error?.code).toBe("MIST_INTERACTION_UNSUPPORTED");
    expect(port.received.length).toBe(0);
    await engine.close();
  });
});
