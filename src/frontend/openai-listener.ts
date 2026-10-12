/**
 * #218/D31 生产网络入口的第一处约束（图纸 §7）。
 *
 * 默认只绑 loopback；请求体、附件与并发都有上限；默认不发任何 CORS 头，更不发
 * wildcard `*`。令牌不进 query string（本层不读 query 参数），鉴权仍由下游 adapter
 * 在解析消息、读取主流与调用模型之前完成。传输层不解析 `Authorization` 内容，只把
 * 请求交给注入的 handler port（合成或真实），保持「一个入口接一窗流唯一 writer」。
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

export interface FrontendListenerOptions {
  /** 默认 `127.0.0.1`：非 loopback 必须由调用方显式传入。 */
  bindAddress?: string;
  /** 默认 0（临时端口）。 */
  port?: number;
  /** 原始请求体字节上限，默认 1 MiB；超限 413。传输层不解析 messages/附件。 */
  maxBodyBytes?: number;
  /** 同时处理的请求上限，默认 8；超限 429。 */
  maxConcurrentRequests?: number;
  /** CORS allowlist；默认空 = 不发任何 CORS 头，绝不回 `*`。 */
  allowedOrigins?: readonly string[];
}

export interface FrontendHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FrontendHttpReply {
  status: number;
  body: string;
  /** true 时 `Content-Type: text/event-stream`，否则 `application/json`。 */
  sse: boolean;
}

export type FrontendRequestHandler = (request: FrontendHttpRequest) => Promise<FrontendHttpReply>;

export interface FrontendListener {
  /** 实际绑定地址，例如 `http://127.0.0.1:54321`。 */
  readonly url: string;
  readonly bindAddress: string;
  close(): Promise<void>;
}

const DEFAULTS = {
  bindAddress: "127.0.0.1",
  port: 0,
  maxBodyBytes: 1024 * 1024,
  maxConcurrentRequests: 8,
} as const;

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function applyCors(
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: readonly string[],
): void {
  if (origin === undefined || !allowedOrigins.includes(origin)) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function send(response: ServerResponse, status: number, body: string, sse: boolean): void {
  response.statusCode = status;
  response.setHeader("Content-Type", sse ? "text/event-stream" : "application/json");
  response.end(body);
}

function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let overflow = false;
    request.on("data", (chunk: Buffer) => {
      if (overflow) return;
      total += chunk.length;
      if (total > limit) {
        overflow = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!overflow) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => resolve(null));
  });
}

export async function startFrontendListener(
  handler: FrontendRequestHandler,
  options: FrontendListenerOptions = {},
): Promise<FrontendListener> {
  const bindAddress = options.bindAddress ?? DEFAULTS.bindAddress;
  if (options.bindAddress !== undefined && !isLoopback(bindAddress)) {
    throw new Error(
      `non-loopback bind address ${bindAddress} requires an explicit, reviewed configuration`,
    );
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULTS.maxConcurrentRequests;
  const allowedOrigins = [...(options.allowedOrigins ?? [])];

  let inFlight = 0;
  const server: Server = createServer((request, response) => {
    const origin = request.headers.origin;
    applyCors(response, origin, allowedOrigins);
    if (request.method === "OPTIONS") {
      response.statusCode = allowedOrigins.length > 0 ? 204 : 404;
      response.end();
      return;
    }
    if (request.method !== "POST" || (request.url ?? "").split("?")[0] !== "/v1/chat/completions") {
      send(response, 404, JSON.stringify({ error: { code: "NOT_FOUND" } }), false);
      return;
    }
    if (inFlight >= maxConcurrentRequests) {
      send(response, 429, JSON.stringify({ error: { code: "TOO_MANY_REQUESTS" } }), false);
      return;
    }
    inFlight += 1;
    void (async () => {
      try {
        const body = await readBody(request, maxBodyBytes);
        if (body === null) {
          send(response, 413, JSON.stringify({ error: { code: "REQUEST_TOO_LARGE" } }), false);
          return;
        }
        const reply = await handler({
          method: request.method ?? "POST",
          path: (request.url ?? "").split("?")[0] ?? "",
          headers: request.headers,
          body,
        });
        send(response, reply.status, reply.body, reply.sse);
      } catch {
        send(response, 500, JSON.stringify({ error: { code: "INTERNAL" } }), false);
      } finally {
        inFlight -= 1;
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: bindAddress, port: options.port ?? DEFAULTS.port }, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://${bindAddress}:${port}`,
    bindAddress,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
