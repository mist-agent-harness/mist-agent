/**
 * D31-1 管理 API 单元证据：对**真实 HTTP 合成 native WebUI API 服务**验证
 * signin/list/create/toggle/getById 全路径（不 source.includes），覆盖
 * already-active 不翻 off、401/403 不当 missing、unknown-source 同 id 拒绝、
 * malformed/upstream-canary 不回显、token/密码不落公开面、未知/非 loopback 端点拒绝。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  PIPE_FUNCTION_ID,
  PIPE_OWNER_META,
  WebuiManagementApi,
  WebuiManagementError,
} from "../src/frontend/webui-management-api.ts";
import { type SyntheticWebuiApi, startSyntheticWebuiApi } from "./fixtures/synthetic-webui-api.ts";

const ADMIN_EMAIL = "admin@mist.local";
const ADMIN_PASSWORD = "synthetic-admin-password";
const CANARY = "UPSTREAM_CANARY_SHOULD_NOT_ECHO";
const PIPE_SOURCE = readFileSync(
  new URL("../assets/openwebui/mist-pipe.py", import.meta.url),
  "utf8",
);

const servers: SyntheticWebuiApi[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function server(options: Partial<Parameters<typeof startSyntheticWebuiApi>[0]> = {}) {
  const started = await startSyntheticWebuiApi({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    token: "synth-bearer-token",
    canary: CANARY,
    ...options,
  });
  servers.push(started);
  return started;
}

function client(baseUrl: string, overrides: Partial<{ functionId: string }> = {}) {
  return new WebuiManagementApi({
    pipeSource: PIPE_SOURCE,
    requestTimeoutMs: 5_000,
    ...overrides,
  });
}

function ownedSeed(id = PIPE_FUNCTION_ID) {
  return {
    id,
    type: "pipe",
    name: "Mist (text)",
    content: PIPE_SOURCE,
    is_active: true,
    meta: { mistOwner: PIPE_OWNER_META, description: "x" },
  };
}

describe("#218 WebUI management API", () => {
  it("signs in, creates the pipe, toggles it on, and verifies active/owned", async () => {
    const api = await server();
    const outcome = await client(api.url).ensurePipe({
      serviceId: "s",
      baseUrl: api.url,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(outcome).toEqual({ functionId: PIPE_FUNCTION_ID, created: true, toggled: true });
    expect(api.createCalls).toBe(1);
    expect(api.toggleCalls).toBe(1);
    expect(api.functions.get(PIPE_FUNCTION_ID)?.is_active).toBe(true);
  });

  it("does not toggle an already-active owned pipe (no off-flip)", async () => {
    const seed = ownedSeed();
    const api = await server({ seed: [seed] });
    const outcome = await client(api.url).ensurePipe({
      serviceId: "s",
      baseUrl: api.url,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(outcome).toEqual({ functionId: PIPE_FUNCTION_ID, created: false, toggled: false });
    expect(api.createCalls).toBe(0);
    expect(api.toggleCalls).toBe(0);
    expect(api.functions.get(PIPE_FUNCTION_ID)?.is_active).toBe(true);
  });

  it("refuses to reuse an unknown external function with the same id", async () => {
    const api = await server({
      seed: [
        {
          id: PIPE_FUNCTION_ID,
          type: "filter",
          name: "not ours",
          content: "# someone else's code",
          is_active: true,
          meta: { description: "foreign" },
        },
      ],
    });
    await expect(
      client(api.url).ensurePipe({
        serviceId: "s",
        baseUrl: api.url,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "WEBUI_FUNCTION_OCCUPIED" });
    expect(api.createCalls).toBe(0);
  });

  it("rejects a matching marker and metadata when the pipe source was changed", async () => {
    const changed = ownedSeed();
    changed.content += "\n# modified after registration\n";
    const api = await server({ seed: [changed] });
    await expect(
      client(api.url).ensurePipe({
        serviceId: "s",
        baseUrl: api.url,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "WEBUI_FUNCTION_OCCUPIED" });
    expect(api.createCalls).toBe(0);
    expect(api.toggleCalls).toBe(0);
  });

  it("fails closed on malformed list and malformed/mismatched details without create or toggle", async () => {
    const seed = ownedSeed();
    for (const options of [
      { malformedListRecord: true },
      { seed: [seed], detailWrongId: true },
      { seed: [seed], detailMissingIsActive: true },
    ]) {
      const api = await server(options);
      await expect(
        client(api.url).ensurePipe({
          serviceId: "s",
          baseUrl: api.url,
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        }),
      ).rejects.toMatchObject({
        code: options.malformedListRecord
          ? "WEBUI_MANAGEMENT_LIST_FAILED"
          : "WEBUI_FUNCTION_LOOKUP_FAILED",
      });
      expect(api.createCalls).toBe(0);
      expect(api.toggleCalls).toBe(0);
    }
  });

  it("treats list 401/403 as auth failure, never as 'no functions'", async () => {
    for (const status of [401, 403]) {
      const api = await server({ listStatus: status });
      await expect(
        client(api.url).ensurePipe({
          serviceId: "s",
          baseUrl: api.url,
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        }),
      ).rejects.toMatchObject({ code: "WEBUI_ADMIN_AUTH_FAILED" });
      expect(api.createCalls).toBe(0);
    }
  });

  it("treats GET id 401 as NOT_FOUND (not success, not auth)", async () => {
    const api = await server({ getByIdStatus: 401 });
    await expect(
      client(api.url).ensurePipe({
        serviceId: "s",
        baseUrl: api.url,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "WEBUI_FUNCTION_REGISTER_FAILED" });
  });

  it("rejects signin failure and malformed signin without echoing upstream", async () => {
    for (const options of [{ signinStatus: 400 }, { malformedSignin: true }]) {
      const api = await server(options);
      const error = await client(api.url)
        .ensurePipe({
          serviceId: "s",
          baseUrl: api.url,
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WebuiManagementError);
      const management = error as WebuiManagementError;
      expect(management.code).toBe("WEBUI_ADMIN_AUTH_FAILED");
      expect(management.message).not.toContain(CANARY);
      expect(management.remedy).not.toContain(CANARY);
    }
  });

  it("does not leak token or password into public request surfaces", async () => {
    const api = await server();
    await client(api.url).ensurePipe({
      serviceId: "s",
      baseUrl: api.url,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const nonSignin = api.requests.filter((r) => r.path !== "/api/v1/auths/signin");
    for (const request of nonSignin) {
      expect(request.path).not.toContain("synth-bearer-token");
      expect(request.body).not.toContain(ADMIN_PASSWORD);
      expect(request.body).not.toContain("synth-bearer-token");
    }
    // 只有 signin 请求体带密码；其余绝无。
    const signin = api.requests.filter((r) => r.path === "/api/v1/auths/signin");
    expect(signin.length).toBeGreaterThan(0);
  });

  it("rejects a non-loopback management endpoint before any HTTP", async () => {
    const error = await client("http://example.com")
      .ensurePipe({
        serviceId: "s",
        baseUrl: "http://example.com",
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      })
      .catch((e: unknown) => e);
    expect((error as WebuiManagementError).code).toBe("WEBUI_MANAGEMENT_ENDPOINT_UNTRUSTED");
  });

  it("bounds a real HTTP response whose headers arrive but body stalls", async () => {
    const api = await server({ stallListBody: true });
    const started = Date.now();
    await expect(
      new WebuiManagementApi({ pipeSource: PIPE_SOURCE, requestTimeoutMs: 100 }).ensurePipe({
        serviceId: "s",
        baseUrl: api.url,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "WEBUI_MANAGEMENT_UNREACHABLE" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("rejects an illegal (hyphenated) management function id", () => {
    expect(
      () => new WebuiManagementApi({ pipeSource: PIPE_SOURCE, functionId: "mist-openai-pipe" }),
    ).toThrowError(/WEBUI_MANAGEMENT_ID_INVALID/);
  });

  it("fails with a bounded code when the endpoint is unreachable", async () => {
    await expect(
      new WebuiManagementApi({ pipeSource: PIPE_SOURCE, requestTimeoutMs: 1_000 }).ensurePipe({
        serviceId: "s",
        baseUrl: "http://127.0.0.1:9",
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "WEBUI_MANAGEMENT_UNREACHABLE" });
  });
});
