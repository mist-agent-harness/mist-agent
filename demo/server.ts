import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { ClaudeAuthenticationError } from "./brain-claude.ts";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface DemoMessage {
  role: string;
  content: string;
}

export interface DemoDriver {
  say(residentId: string, message: string): Promise<{ content: string }>;
  killSession(residentId: string): Promise<void>;
}

export interface DemoResident {
  driver: DemoDriver;
  residentId: string;
}

/**
 * Demo runtime ownership stays outside the HTTP shell.
 *
 * E4 can replace both the driver and resident during reset without teaching this
 * server how seed data is stored. Every request takes one current snapshot after
 * entering the serial queue, so reset cannot leave a request with a mixed pair.
 */
export interface DemoRuntime {
  current(): DemoResident;
  reset(): Promise<void>;
}

export interface DemoRequestView {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export interface DemoHttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface DemoChatRequest {
  messages: DemoMessage[];
  context: unknown;
}

/**
 * Wire formats are adapters, not demo state.
 *
 * An OpenAI, Anthropic, or Kimi-specific adapter may decode its own envelope,
 * but it must hand the complete normalized message list to the core. The core
 * alone chooses the latest user message, so a shell replaying old history never
 * writes that history into Mist's authoritative tree.
 */
export interface DemoChatAdapter {
  matches(request: DemoRequestView): boolean;
  parseRequest(body: unknown, request: DemoRequestView): DemoChatRequest;
  formatReply(
    assistantContent: string,
    parsed: DemoChatRequest,
    request: DemoRequestView,
  ): DemoHttpResponse;
}

export interface DemoServerOptions {
  runtime: DemoRuntime;
  adapters: readonly DemoChatAdapter[];
  maxBodyBytes?: number;
  onError?: (error: unknown) => void;
}

export interface DemoServer {
  /** Per-process secret required by destructive control routes. */
  readonly controlToken: string;
  /** Starts on loopback only. No public-bind escape hatch is exposed. */
  start(port: number): Promise<AddressInfo>;
  stop(): Promise<void>;
  address(): AddressInfo | null;
}

class BadRequestError extends Error {}
class PayloadTooLargeError extends Error {}

function requestView(request: IncomingMessage): DemoRequestView {
  return {
    method: request.method ?? "GET",
    url: request.url ?? "/",
    headers: request.headers,
  };
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return url;
  }
}

function hasControlAuthorization(headers: IncomingHttpHeaders, token: string): boolean {
  const authorization = headers.authorization;
  if (typeof authorization !== "string") return false;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
  if (match?.[1] === undefined) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function latestUserMessage(messages: readonly DemoMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      const content = withoutKimiSystemReminders(message.content);
      if (content.trim().length > 0) return content;
    }
  }
  return null;
}

function withoutKimiSystemReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}

function send(response: ServerResponse, value: DemoHttpResponse): void {
  response.statusCode = value.status ?? 200;
  for (const [name, headerValue] of Object.entries(value.headers ?? {})) {
    response.setHeader(name, headerValue);
  }
  response.end(value.body);
}

function sendJson(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  send(response, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(value),
  });
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BadRequestError();
    if (parsed > maxBodyBytes) throw new PayloadTooLargeError();
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBodyBytes) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }

  if (total === 0) throw new BadRequestError();
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new BadRequestError();
  }
}

function serialExecutor() {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function createDemoServer(options: DemoServerOptions): DemoServer {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const controlToken = randomBytes(32).toString("base64url");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError("maxBodyBytes must be a positive safe integer");
  }
  if (options.adapters.length === 0) {
    throw new RangeError("at least one demo chat adapter is required");
  }

  const runSerial = serialExecutor();
  const server = createServer((request, response) => {
    void (async () => {
      const view = requestView(request);
      const pathname = pathnameOf(view.url);

      if (pathname === "/demo/clear") {
        if (view.method !== "POST") {
          response.setHeader("allow", "POST");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (!hasControlAuthorization(view.headers, controlToken)) {
          response.setHeader("www-authenticate", 'Bearer realm="mist-demo-control"');
          sendJson(response, 401, { error: "control_token_required" });
          return;
        }
        await runSerial(async () => {
          const { driver, residentId } = options.runtime.current();
          await driver.killSession(residentId);
        });
        response.statusCode = 204;
        response.end();
        return;
      }

      if (pathname === "/demo/reset") {
        if (view.method !== "POST") {
          response.setHeader("allow", "POST");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        if (!hasControlAuthorization(view.headers, controlToken)) {
          response.setHeader("www-authenticate", 'Bearer realm="mist-demo-control"');
          sendJson(response, 401, { error: "control_token_required" });
          return;
        }
        await runSerial(() => options.runtime.reset());
        response.statusCode = 204;
        response.end();
        return;
      }

      const adapter = options.adapters.find((candidate) => candidate.matches(view));
      if (adapter === undefined) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const body = await readJson(request, maxBodyBytes);
      let parsed: DemoChatRequest;
      try {
        parsed = adapter.parseRequest(body, view);
      } catch {
        throw new BadRequestError();
      }
      if (!Array.isArray(parsed.messages)) throw new BadRequestError();
      const latest = latestUserMessage(parsed.messages);
      if (latest === null) throw new BadRequestError();

      const assistantContent = await runSerial(async () => {
        const { driver, residentId } = options.runtime.current();
        const reply = await driver.say(residentId, latest);
        return reply.content;
      });
      send(response, adapter.formatReply(assistantContent, parsed, view));
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        sendJson(response, 413, { error: "payload_too_large" });
        return;
      }
      if (error instanceof BadRequestError) {
        sendJson(response, 400, { error: "bad_request" });
        return;
      }
      if (error instanceof ClaudeAuthenticationError) {
        sendJson(response, 503, {
          error: "claude_authentication_required",
          message: error.message,
        });
        return;
      }
      options.onError?.(error);
      sendJson(response, 500, { error: "internal_error" });
    });
  });

  return {
    controlToken,
    start(port) {
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        return Promise.reject(new RangeError("port must be an integer from 0 through 65535"));
      }
      if (server.listening) return Promise.reject(new Error("demo server is already listening"));
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("demo server did not expose a TCP address"));
            return;
          }
          resolve(address);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen({ host: LOOPBACK_HOST, port });
      });
    },
    stop() {
      if (!server.listening) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
    address() {
      const address = server.address();
      return address !== null && typeof address !== "string" ? address : null;
    },
  };
}
