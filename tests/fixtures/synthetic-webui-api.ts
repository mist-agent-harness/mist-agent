/**
 * D31-1 合成 **Open WebUI v0.11.4 原生管理 API** 服务（真实 node:http，真 HTTP）：
 * 按官方 routers/functions.py、routers/auths.py 的状态码/schema 实现
 *   POST /api/v1/auths/signin         {email,password} → {token,token_type:"Bearer"}
 *   GET  /api/v1/functions/list        admin → [ {id,type,is_active,meta,...} ]；无/错 token→401
 *   GET  /api/v1/functions/id/{id}     存在→200；不存在→401（NOT_FOUND，不是 404）
 *   POST /api/v1/functions/create      {id,name,content,meta}；id 已存在→400；成功→200
 *   POST /api/v1/functions/id/{id}/toggle  is_active 取反→200；不存在→401
 * 全程记录请求（含 Authorization 头）供断言「token/密码不落公开面」。
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

export interface SyntheticFunction {
  id: string;
  type: string;
  name: string;
  content: string;
  is_active: boolean;
  meta: Record<string, unknown>;
}

export interface SyntheticApiOptions {
  readonly email: string;
  readonly password: string;
  readonly token?: string;
  /** true 时接受任意非空邮箱/密码（平台集成测试用：平台随机生成专属凭据）。 */
  readonly acceptAny?: boolean;
  /** 预置 function（用于 unknown-source / already-active 场景）。 */
  readonly seed?: SyntheticFunction[];
  readonly signinStatus?: number;
  readonly listStatus?: number;
  readonly createStatus?: number;
  readonly toggleStatus?: number;
  readonly getByIdStatus?: number;
  readonly malformedSignin?: boolean;
  readonly stallListBody?: boolean;
  readonly malformedListRecord?: boolean;
  readonly detailWrongId?: boolean;
  readonly detailMissingIsActive?: boolean;
  readonly canary?: string;
}

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

export interface SyntheticWebuiApi {
  readonly url: string;
  readonly requests: CapturedRequest[];
  readonly functions: Map<string, SyntheticFunction>;
  readonly signinCalls: number;
  readonly createCalls: number;
  readonly toggleCalls: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function publicFunction(fn: SyntheticFunction): Record<string, unknown> {
  return {
    id: fn.id,
    user_id: "u-admin",
    name: fn.name,
    type: fn.type,
    content: fn.content,
    meta: fn.meta,
    is_active: fn.is_active,
    is_global: false,
    updated_at: 0,
    created_at: 0,
  };
}

export async function startSyntheticWebuiApi(
  options: SyntheticApiOptions,
): Promise<SyntheticWebuiApi> {
  const token = options.token ?? "synth-bearer-token";
  const functions = new Map<string, SyntheticFunction>();
  for (const fn of options.seed ?? []) functions.set(fn.id, fn);
  const requests: CapturedRequest[] = [];
  let signinCalls = 0;
  let createCalls = 0;
  let toggleCalls = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const body = await readBody(req);
      const authorization = req.headers.authorization ?? null;
      requests.push({ method, path, authorization, body });
      const authed = authorization === `Bearer ${token}`;

      if (method === "POST" && path === "/api/v1/auths/signin") {
        signinCalls += 1;
        if (options.signinStatus !== undefined && options.signinStatus !== 200) {
          return send(res, options.signinStatus, {
            detail: options.canary ?? "invalid credentials",
          });
        }
        if (options.malformedSignin) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{not-json");
          return;
        }
        let parsed: { email?: string; password?: string } = {};
        try {
          parsed = JSON.parse(body) as { email?: string; password?: string };
        } catch {
          return send(res, 400, { detail: "bad body" });
        }
        if (parsed.email !== options.email || parsed.password !== options.password) {
          if (
            options.acceptAny !== true ||
            parsed.email === undefined ||
            parsed.password === undefined
          ) {
            return send(res, 400, { detail: options.canary ?? "invalid credentials" });
          }
        }
        return send(res, 200, { token, token_type: "Bearer", id: "u-admin", role: "admin" });
      }

      if (method === "GET" && path === "/api/v1/functions/list") {
        if (options.listStatus !== undefined && options.listStatus !== 200) {
          return send(res, options.listStatus, { detail: options.canary ?? "forbidden" });
        }
        if (!authed) return send(res, 401, { detail: "unauthorized" });
        if (options.stallListBody) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.flushHeaders();
          return;
        }
        const records = [...functions.values()].map(publicFunction);
        if (options.malformedListRecord) {
          if (records[0] !== undefined) records[0].is_active = undefined;
          else records.push({ id: "malformed", type: "pipe" });
        }
        return send(res, 200, records);
      }

      const idMatch = /^\/api\/v1\/functions\/id\/([^/]+)$/.exec(path);
      if (method === "GET" && idMatch !== null) {
        if (!authed) return send(res, 401, { detail: "unauthorized" });
        if (options.getByIdStatus !== undefined && options.getByIdStatus !== 200) {
          return send(res, options.getByIdStatus, { detail: options.canary ?? "not found" });
        }
        const fn = functions.get(decodeURIComponent(idMatch[1] ?? ""));
        if (fn === undefined) return send(res, 401, { detail: "function not found" });
        const detail = publicFunction(fn);
        if (options.detailWrongId) detail.id = "unexpected-id";
        if (options.detailMissingIsActive) detail.is_active = undefined;
        return send(res, 200, detail);
      }

      if (method === "POST" && path === "/api/v1/functions/create") {
        createCalls += 1;
        if (!authed) return send(res, 401, { detail: "unauthorized" });
        if (options.createStatus !== undefined && options.createStatus !== 200) {
          return send(res, options.createStatus, { detail: options.canary ?? "create rejected" });
        }
        let form: SyntheticFunction;
        try {
          form = JSON.parse(body) as SyntheticFunction;
        } catch {
          return send(res, 400, { detail: "bad body" });
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.id)) {
          return send(res, 400, { detail: "id not identifier" });
        }
        if (functions.has(form.id)) return send(res, 400, { detail: "id taken" });
        const created: SyntheticFunction = {
          id: form.id,
          type: "pipe",
          name: form.name,
          content: form.content,
          is_active: false,
          meta: form.meta ?? {},
        };
        functions.set(created.id, created);
        return send(res, 200, publicFunction(created));
      }

      const toggleMatch = /^\/api\/v1\/functions\/id\/([^/]+)\/toggle$/.exec(path);
      if (method === "POST" && toggleMatch !== null) {
        toggleCalls += 1;
        if (!authed) return send(res, 401, { detail: "unauthorized" });
        if (options.toggleStatus !== undefined && options.toggleStatus !== 200) {
          return send(res, options.toggleStatus, { detail: options.canary ?? "toggle rejected" });
        }
        const fn = functions.get(decodeURIComponent(toggleMatch[1] ?? ""));
        if (fn === undefined) return send(res, 401, { detail: "function not found" });
        fn.is_active = !fn.is_active;
        return send(res, 200, publicFunction(fn));
      }

      send(res, 404, { detail: "unknown route" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    functions,
    get signinCalls() {
      return signinCalls;
    },
    get createCalls() {
      return createCalls;
    },
    get toggleCalls() {
      return toggleCalls;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
