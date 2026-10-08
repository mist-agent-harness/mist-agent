/**
 * D31-1 真实系统平台测试：假执行器（严格解析 argv/记录生命周期）+ 真实 NodeCommandRunner
 * 与合成 docker CLI/短命服务；token 只在 child env；局部失败回收；真实插件事务组合隔离。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebuiInstallError, WebuiInstaller } from "../src/frontend/webui-install.ts";
import {
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
  NodeCommandRunner,
  WEBUI_DOCKER_IMAGE,
  WEBUI_PIP_PACKAGE,
  WebuiContainerOwnershipError,
  WebuiPlatformError,
  WebuiSystemPlatform,
  childEnv,
} from "../src/frontend/webui-platform.ts";
import { type SyntheticWebuiApi, startSyntheticWebuiApi } from "./fixtures/synthetic-webui-api.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-webui-platform-"));
  dirs.push(dir);
  return dir;
}
const ADCANARY = "SYNTHETIC_TOKEN_CANARY";

// 真实 HTTP 合成 native WebUI 管理 API：平台经真实 WebuiManagementApi 走真 HTTP 注册。
let api: SyntheticWebuiApi;
beforeEach(async () => {
  api = await startSyntheticWebuiApi({ email: "x@mist.local", password: "y", acceptAny: true });
});
afterEach(async () => {
  await api.close();
});

class FakeRunner implements CommandRunner {
  readonly runCalls: CommandInvocation[] = [];
  readonly startContainerCalls: Array<CommandInvocation & { name: string }> = [];
  readonly startProcessCalls: Array<CommandInvocation & { name: string }> = [];
  readonly stopContainerCalls: string[] = [];
  readonly stopProcessCalls: string[] = [];
  containerStartThrows = false;
  containerStopThrows = false;
  processStartThrows = false;
  containerRunning = "true";
  healthBody = '{"status":true}\n200';
  modelsStatus = "401";
  pythonVersion = "Python 3.12.13";

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.runCalls.push(invocation);
    if (invocation.file === "docker" && invocation.args[0] === "info")
      return { code: 0, stdout: "27.0.3", stderr: "" };
    if (invocation.file === "docker" && invocation.args[0] === "inspect")
      return { code: 0, stdout: this.containerRunning, stderr: "" };
    if (invocation.args.includes("--version"))
      return { code: 0, stdout: "", stderr: this.pythonVersion };
    if (invocation.args.some((arg) => arg.includes("/health")))
      return { code: 0, stdout: this.healthBody, stderr: "" };
    if (invocation.args.some((arg) => arg.includes("/models")))
      return { code: 0, stdout: `${this.modelsStatus}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async startContainer(invocation: CommandInvocation & { name: string }) {
    this.startContainerCalls.push(invocation);
    if (this.containerStartThrows) throw new Error("container start failed");
    return { containerId: "abcdef012345" };
  }
  async startProcess(invocation: CommandInvocation & { name: string }) {
    this.startProcessCalls.push(invocation);
    if (this.processStartThrows) throw new Error("process exited early");
    return { pid: 4242 };
  }
  async stopContainer(name: string) {
    this.stopContainerCalls.push(name);
    if (this.containerStopThrows) throw new Error("container stop failed");
  }
  async stopProcess(name: string) {
    this.stopProcessCalls.push(name);
    if (this.containerStopThrows) throw new Error("process stop failed");
  }
  async isProcessAlive() {
    return true;
  }
}

function platform(
  runner: FakeRunner,
  isPortFree: (p: number) => Promise<boolean> = async () => true,
  managementBaseUrl: string = api.url,
) {
  return new WebuiSystemPlatform({
    dataDir: temp(),
    runner,
    resolveEndpoint: () => "http://127.0.0.1:8787",
    isPortFree,
    healthMaxAttempts: 3,
    healthPollIntervalMs: 0,
    managementBaseUrl,
  });
}

const SERVICE = {
  runtime: "docker" as const,
  serviceId: "webui-endpoint-w",
  endpointId: "endpoint-w",
  token: ADCANARY,
};

describe("#218 real WebUI system platform", () => {
  it("detects docker and python 3.12 via候选路径", async () => {
    const runner = new FakeRunner();
    expect(await platform(runner).detectEnvironment()).toMatchObject({
      docker: true,
      python: true,
      pythonVersion: "3.12.13",
    });
  });

  it("passes docker argv as真实数组 with split --env, host network, data mount, and token only in child env", async () => {
    const runner = new FakeRunner();
    const started = await platform(runner).startService(SERVICE);
    expect(started.runtimeUsed).toBe("docker");
    const start = runner.startContainerCalls[0];
    if (start === undefined) throw new Error("no start");
    expect(start.args[start.args.indexOf("--network") + 1]).toBe("host");
    expect(start.args).toContain("--env");
    expect(start.args).toContain("ENABLE_CONTEXT_COMPACTION=False");
    expect(start.args).not.toContain("--env ENABLE_CONTEXT_COMPACTION=False"); // 不合并成单元素
    expect(start.args[start.args.indexOf("--mount") + 1]).toContain("target=/app/backend/data");
    expect(start.args[start.args.indexOf("OPENAI_API_KEY") - 1]).toBe("--env");
    expect(start.args).toContain(WEBUI_DOCKER_IMAGE);
    expect(start.args.join("\u0000")).not.toContain(ADCANARY);
    expect(start.env?.OPENAI_API_KEY).toBe(ADCANARY);
    // 只继承必要环境：不夹带 ambient provider secret。
    expect(start.env?.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("rejects when the port is already occupied before any start", async () => {
    const runner = new FakeRunner();
    await expect(platform(runner, async () => false).startService(SERVICE)).rejects.toMatchObject({
      code: "WEBUI_PORT_IN_USE",
    });
    expect(runner.startContainerCalls.length).toBe(0);
  });

  it("cleans up an owned container when start fails, and reports a stable code", async () => {
    const runner = new FakeRunner();
    runner.containerStartThrows = true;
    await expect(platform(runner).startService(SERVICE)).rejects.toBeInstanceOf(WebuiPlatformError);
    expect(runner.stopContainerCalls.length).toBe(1);
  });

  it("keeps ownership and reports cleanup failure when stop also fails (no washing)", async () => {
    const runner = new FakeRunner();
    runner.containerStartThrows = true;
    runner.containerStopThrows = true;
    await expect(platform(runner).startService(SERVICE)).rejects.toMatchObject({
      code: "WEBUI_CLEANUP_FAILED",
    });
  });

  it("rejects when the probe fails after start and reclaims the container", async () => {
    const runner = new FakeRunner();
    runner.healthBody = "\n503";
    await expect(platform(runner).startService(SERVICE)).rejects.toMatchObject({
      code: "WEBUI_NOT_READY",
    });
    expect(runner.stopContainerCalls.length).toBe(1);
  });

  it("runs the pinned python path with a dedicated venv and split env", async () => {
    const runner = new FakeRunner();
    const started = await platform(runner).startService({ ...SERVICE, runtime: "python" });
    expect(started.runtimeUsed).toBe("python");
    const pip = runner.runCalls.find((call) => call.args.includes("pip"));
    expect(pip?.args).toContain(WEBUI_PIP_PACKAGE);
    const serve = runner.startProcessCalls[0];
    expect(serve?.args).toEqual(["serve", "--host", "127.0.0.1", "--port", "8080"]);
    expect(serve?.args.join("\u0000")).not.toContain(ADCANARY);
    expect(serve?.env?.OPENAI_API_KEY).toBe(ADCANARY);
    expect(serve?.env?.ENABLE_PERSISTENT_CONFIG).toBe("False");
  });

  it("stop is idempotent and only reclaims owned services", async () => {
    const runner = new FakeRunner();
    const p = platform(runner);
    await p.startService(SERVICE);
    await p.stopService(SERVICE.serviceId);
    await p.stopService(SERVICE.serviceId);
    await p.stopService("not-owned");
    expect(runner.stopContainerCalls.length).toBe(1);
  });

  it("childEnv only inherits necessary runtime vars", () => {
    process.env.SYNTHETIC_AMBIENT_CANARY = "1";
    const env = childEnv({ OPENAI_API_KEY: "x" });
    expect(env.SYNTHETIC_AMBIENT_CANARY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("x");
    expect(env.PATH).toBeDefined();
  });
});

describe("#218 NodeCommandRunner real exit/cleanup", () => {
  function fakeDocker(): { bin: string; stateDir: string } {
    const dir = temp();
    const stateDir = join(dir, "state");
    const bin = join(dir, "docker");
    writeFileSync(
      bin,
      `#!/bin/sh
set -eu
STATE="${stateDir}"
if [ "$1" = "run" ]; then
  name="$4"
  id="containerid-$name"
  mkdir -p "$STATE"
  echo "$id" > "$STATE/$id"
  echo "$id"
  exit 0
fi
if [ "$1" = "rm" ]; then
  for a in "$@"; do
    if [ -f "$STATE/$a" ]; then rm -f "$STATE/$a"; fi
  done
  exit 0
fi
exit 0
`,
      "utf8",
    );
    chmodSync(bin, 0o755);
    return { bin, stateDir };
  }

  it("checks the docker client exit and actually removes the owned container", async () => {
    const { bin, stateDir } = fakeDocker();
    const runner = new NodeCommandRunner({ dockerBin: bin });
    await runner.startContainer({
      file: bin,
      args: ["run", "-d", "--name", "c1", "--label", "mist.ownerNonce=1234567890123456"],
      name: "c1",
      env: {},
    });
    expect(existsSync(join(stateDir, "containerid-c1"))).toBe(true);
    await runner.stopContainer("c1");
    expect(existsSync(join(stateDir, "containerid-c1"))).toBe(false);
  });

  it("fails when the container client exits non-zero", async () => {
    const dir = temp();
    const bin = join(dir, "docker");
    writeFileSync(bin, "#!/bin/sh\nexit 23\n", "utf8");
    chmodSync(bin, 0o755);
    const runner = new NodeCommandRunner();
    await expect(
      runner.startContainer({
        file: bin,
        args: ["run", "-d", "--name", "c2", "--label", "mist.ownerNonce=1234567890123456"],
        name: "c2",
        env: {},
      }),
    ).rejects.toThrow();
  });

  it("recovers a partial create only after inspect proves the nonce and removes its actual id", async () => {
    const dir = temp();
    const bin = join(dir, "docker");
    const stateDir = join(dir, "state");
    writeFileSync(
      bin,
      `#!/bin/sh
set -eu
STATE="${stateDir}"
if [ "$1" = "run" ]; then
  id="actual-container-id"
  nonce=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--label" ]; then nonce="\${arg#mist.ownerNonce=}"; fi
    previous="$arg"
  done
  mkdir -p "$STATE"
  printf '%s' "$nonce" > "$STATE/nonce"
  echo "$id"
  exit 23
fi
if [ "$1" = "inspect" ]; then
  printf 'actual-container-id %s\n' "$(cat "$STATE/nonce")"
  exit 0
fi
if [ "$1" = "rm" ]; then
  rm -f "$STATE/nonce"
  exit 0
fi
exit 0
`,
      "utf8",
    );
    chmodSync(bin, 0o755);
    const runner = new NodeCommandRunner({ dockerBin: bin });
    const invocation = {
      file: bin,
      args: ["run", "-d", "--name", "partial", "--label", "mist.ownerNonce=12345678901234567890"],
      name: "partial",
      env: {},
    };
    await expect(runner.startContainer(invocation)).rejects.toThrow(/container start failed/);
    expect(existsSync(join(stateDir, "nonce"))).toBe(true);
    await runner.stopContainer("partial");
    expect(existsSync(join(stateDir, "nonce"))).toBe(false);
  });

  it("quarantines uncertain container ownership through the real plugin store and rejects reset/stop", async () => {
    class UncertainRunner extends FakeRunner {
      override async startContainer(
        _invocation: CommandInvocation & { name: string },
      ): Promise<{ containerId: string }> {
        throw new WebuiContainerOwnershipError();
      }
    }
    const runner = new UncertainRunner();
    const dataDir = temp();
    const platform = new WebuiSystemPlatform({
      dataDir: join(dataDir, "platform"),
      runner,
      resolveEndpoint: () => "http://127.0.0.1:8787",
      isPortFree: async () => true,
      healthMaxAttempts: 0,
      managementBaseUrl: api.url,
    });
    const installer = new WebuiInstaller({
      dataDir: join(dataDir, "plugins"),
      appliance: platform,
    });
    await expect(
      installer.run(
        {
          bindingId: "binding:w",
          endpointId: "endpoint-w",
          residentId: "r",
          scopeId: "private",
          streamId: "stream:r",
          token: ADCANARY,
          serverModel: "mist:w",
          canonicalWriterId: "owner:r",
        },
        { confirmed: true, environment: { docker: true, python: false } },
      ),
    ).rejects.toBeInstanceOf(WebuiInstallError);
    const ledger = readFileSync(join(dataDir, "plugins", "mist-webui.json"), "utf8");
    expect(ledger).toContain("quarantined");
    await expect(installer.stop("webui-endpoint-w")).rejects.toMatchObject({
      code: "WEBUI_CLEANUP_INCOMPLETE",
    });
    await expect(installer.reset()).rejects.toMatchObject({ code: "WEBUI_CLEANUP_INCOMPLETE" });
    expect(readFileSync(join(dataDir, "plugins", "mist-webui.json"), "utf8")).toBe(ledger);
    expect(runner.stopContainerCalls).toEqual([]);
  });

  it("never removes a container whose inspected nonce is foreign or whose inspect failed", async () => {
    for (const inspectMode of ["foreign", "failed"]) {
      const dir = temp();
      const bin = join(dir, "docker");
      const removed = join(dir, "removed");
      const mode = inspectMode;
      writeFileSync(
        bin,
        `#!/bin/sh
if [ "$1" = "run" ]; then echo maybe-created-id; exit 23; fi
if [ "$1" = "inspect" ]; then
  if [ "${mode}" = "foreign" ]; then echo 'maybe-created-id different-nonce'; exit 0; fi
  echo 'daemon unavailable' >&2; exit 44
fi
if [ "$1" = "rm" ]; then touch "${removed}"; exit 0; fi
exit 0
`,
        "utf8",
      );
      chmodSync(bin, 0o755);
      const runner = new NodeCommandRunner({ dockerBin: bin });
      await expect(
        runner.startContainer({
          file: bin,
          args: ["run", "-d", "--name", "uncertain", "--label", "mist.ownerNonce=1234567890123456"],
          name: "uncertain",
          env: {},
        }),
      ).rejects.toBeInstanceOf(WebuiContainerOwnershipError);
      await runner.stopContainer("uncertain");
      expect(existsSync(removed)).toBe(false);
    }
  });

  it("does not inherit ambient provider secrets into a real child", async () => {
    const dir = temp();
    const bin = join(dir, "printenv-canary");
    const out = join(dir, "out.txt");
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s' "\${SYNTHETIC_AMBIENT_CANARY:-none}" > "${out}"\n`,
      "utf8",
    );
    chmodSync(bin, 0o755);
    process.env.SYNTHETIC_AMBIENT_CANARY = "canary";
    const runner = new NodeCommandRunner();
    await runner.run({ file: bin, args: [], env: {} });
    expect(readFileSync(out, "utf8")).toBe("none");
  });
});

describe("#218 NodeCommandRunner process lifecycle", () => {
  it("rejects when a spawned process exits before ready (no hang)", async () => {
    const dir = temp();
    const script = join(dir, "exit23.js");
    writeFileSync(script, "process.exit(23);\n");
    const runner = new NodeCommandRunner();
    await expect(
      runner.startProcess({ file: process.execPath, args: [script], name: "p1", env: {} }),
    ).rejects.toThrow(/exited early/);
  });

  it("keeps a long-lived process alive and stops it", async () => {
    const dir = temp();
    const script = join(dir, "alive.js");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const runner = new NodeCommandRunner();
    const { pid } = await runner.startProcess({
      file: process.execPath,
      args: [script],
      name: "p2",
      env: {},
    });
    expect(pid).toBeGreaterThan(0);
    expect(await runner.isProcessAlive("p2")).toBe(true);
    await runner.stopProcess("p2");
    expect(await runner.isProcessAlive("p2")).toBe(false);
  });

  it("does not remove an unrelated pre-existing container", async () => {
    const dir = temp();
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const unrelated = join(stateDir, "unrelated");
    writeFileSync(unrelated, "keep");
    const bin = join(dir, "docker");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(bin, 0o755);
    const runner = new NodeCommandRunner({ dockerBin: bin });
    await runner.stopContainer("unrelated"); // 未拥有 → no-op
    expect(existsSync(unrelated)).toBe(true);
  });
});

describe("#218 platform -> real management API composition", () => {
  it("registers and enables the Pipe over real HTTP, keeping admin creds out of argv", async () => {
    const runner = new FakeRunner();
    const started = await platform(runner).startService(SERVICE);
    expect(started.runtimeUsed).toBe("docker");
    expect(api.createCalls).toBe(1);
    expect(api.toggleCalls).toBe(1);
    expect(api.functions.get("mist_openai_pipe")?.is_active).toBe(true);
    const start = runner.startContainerCalls[0];
    if (start === undefined) throw new Error("no start");
    expect(start.args[start.args.indexOf("WEBUI_ADMIN_PASSWORD") - 1]).toBe("--env");
    expect(start.args[start.args.indexOf("WEBUI_ADMIN_EMAIL") - 1]).toBe("--env");
    const password = start.env?.WEBUI_ADMIN_PASSWORD;
    expect(typeof password).toBe("string");
    expect(password?.length).toBeGreaterThan(0);
    expect(start.args.join("\u0000")).not.toContain(password as string);
    expect(start.args.join("\u0000")).not.toContain(start.env?.WEBUI_ADMIN_EMAIL as string);
    expect(start.args).toContain("WEBUI_AUTH=True");
  });

  it("does not toggle an already active owned pipe on repeat", async () => {
    api.functions.set("mist_openai_pipe", {
      id: "mist_openai_pipe",
      type: "pipe",
      name: "Mist (text)",
      content: readFileSync(new URL("../assets/openwebui/mist-pipe.py", import.meta.url), "utf8"),
      is_active: true,
      meta: { mistOwner: "mist_openai_pipe" },
    });
    const runner = new FakeRunner();
    await platform(runner).startService(SERVICE);
    expect(api.createCalls).toBe(0);
    expect(api.toggleCalls).toBe(0);
  });

  it("cleans up the service when management registration fails", async () => {
    const failing = await startSyntheticWebuiApi({
      email: "x",
      password: "y",
      acceptAny: true,
      signinStatus: 400,
    });
    try {
      const runner = new FakeRunner();
      await expect(
        platform(runner, async () => true, failing.url).startService(SERVICE),
      ).rejects.toMatchObject({ code: "WEBUI_ADMIN_AUTH_FAILED" });
      expect(runner.stopContainerCalls.length).toBe(1);
    } finally {
      await failing.close();
    }
  });

  it("quarantines when management fails and cleanup also fails", async () => {
    const failing = await startSyntheticWebuiApi({
      email: "x",
      password: "y",
      acceptAny: true,
      signinStatus: 400,
    });
    try {
      const runner = new FakeRunner();
      runner.containerStopThrows = true;
      await expect(
        platform(runner, async () => true, failing.url).startService(SERVICE),
      ).rejects.toMatchObject({ code: "WEBUI_CLEANUP_FAILED" });
    } finally {
      await failing.close();
    }
  });

  it("passes admin credentials to the python service only via child env", async () => {
    const runner = new FakeRunner();
    await platform(runner).startService({ ...SERVICE, runtime: "python" });
    const serve = runner.startProcessCalls[0];
    if (serve === undefined) throw new Error("no serve");
    expect(typeof serve.env?.WEBUI_ADMIN_PASSWORD).toBe("string");
    expect(serve.args.join("\u0000")).not.toContain(serve.env?.WEBUI_ADMIN_PASSWORD as string);
    expect(api.functions.get("mist_openai_pipe")?.is_active).toBe(true);
  });

  it("stores admin credentials only in a 0700 dir / 0600 file and reuses them on restart", async () => {
    const dataDir = temp();
    const runnerA = new FakeRunner();
    await new WebuiSystemPlatform({
      dataDir,
      runner: runnerA,
      resolveEndpoint: () => "http://127.0.0.1:8787",
      isPortFree: async () => true,
      healthMaxAttempts: 3,
      healthPollIntervalMs: 0,
      managementBaseUrl: api.url,
    }).startService(SERVICE);
    const credDir = join(dataDir, "credentials");
    const credFile = join(credDir, "webui-admin.json");
    expect(statSync(credDir).mode & 0o777).toBe(0o700);
    expect(statSync(credFile).mode & 0o777).toBe(0o600);
    const first = JSON.parse(readFileSync(credFile, "utf8")) as { password: string };

    const runnerB = new FakeRunner();
    await new WebuiSystemPlatform({
      dataDir,
      runner: runnerB,
      resolveEndpoint: () => "http://127.0.0.1:8787",
      isPortFree: async () => true,
      healthMaxAttempts: 3,
      healthPollIntervalMs: 0,
      managementBaseUrl: api.url,
    }).startService(SERVICE);
    const second = JSON.parse(readFileSync(credFile, "utf8")) as { password: string };
    expect(second.password).toBe(first.password);
    expect(runnerA.startContainerCalls.length).toBe(1);
    expect(runnerB.startContainerCalls.length).toBe(1);
  });
});

describe("#218 platform management failure cleanup/quarantine variants", () => {
  async function withServer(
    options: Parameters<typeof startSyntheticWebuiApi>[0],
    run: (url: string) => Promise<void>,
  ): Promise<void> {
    const server = await startSyntheticWebuiApi(options);
    try {
      await run(server.url);
    } finally {
      await server.close();
    }
  }

  it("cleans up when create is rejected", async () => {
    await withServer(
      { email: "x", password: "y", acceptAny: true, createStatus: 400 },
      async (url) => {
        const runner = new FakeRunner();
        await expect(
          platform(runner, async () => true, url).startService(SERVICE),
        ).rejects.toMatchObject({ code: "WEBUI_FUNCTION_CREATE_FAILED" });
        expect(runner.stopContainerCalls.length).toBe(1);
      },
    );
  });

  it("cleans up when post-create verify fails", async () => {
    await withServer(
      { email: "x", password: "y", acceptAny: true, getByIdStatus: 401 },
      async (url) => {
        const runner = new FakeRunner();
        await expect(
          platform(runner, async () => true, url).startService(SERVICE),
        ).rejects.toMatchObject({ code: "WEBUI_FUNCTION_REGISTER_FAILED" });
        expect(runner.stopContainerCalls.length).toBe(1);
      },
    );
  });

  it("quarantines when verify fails and cleanup also fails", async () => {
    await withServer(
      { email: "x", password: "y", acceptAny: true, createStatus: 400 },
      async (url) => {
        const runner = new FakeRunner();
        runner.containerStopThrows = true;
        await expect(
          platform(runner, async () => true, url).startService(SERVICE),
        ).rejects.toMatchObject({ code: "WEBUI_CLEANUP_FAILED" });
      },
    );
  });
});
