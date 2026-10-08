/**
 * D31-1 原生 Pipe 测试：真实 Python 3.12（需 starlette/pydantic/requests）+ 合成 HTTP 网关 +
 * 实际 `assets/openwebui/mist-pipe.py`，核普通/SSE/Bearer/task/files/交互拒绝/错误 canary。
 *
 * 解释器发现顺序：`MIST_PIPE_PYTHON` → PATH 的 `python3.12`/`python3.11`。
 * 依赖：`pip install -r assets/openwebui/requirements.txt`（CI 用 setup-python 3.12）。
 * 额外私有依赖目录经 `MIST_PIPE_PYTHONPATH` 注入（可选）。无可用解释器时本用例跳过并告警，
 * 不虚构 passed。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./fixtures/pipe-native-check.py", import.meta.url));

function pipePythonPath(): string | undefined {
  const extra = process.env.MIST_PIPE_PYTHONPATH;
  if (extra !== undefined && extra.length > 0) {
    return `${extra}${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ""}`;
  }
  return process.env.PYTHONPATH;
}

function usablePython(): string | null {
  const candidates = [process.env.MIST_PIPE_PYTHON, "python3.12", "python3.11"].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const pythonPath = pipePythonPath();
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "import starlette, pydantic, requests"], {
      encoding: "utf8",
      env: { ...process.env, ...(pythonPath === undefined ? {} : { PYTHONPATH: pythonPath }) },
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = usablePython();

describe("#218 Open WebUI Pipe native check", () => {
  it("runs the real Pipe against a synthetic gateway", () => {
    // 依赖缺失必须失败（不静默 skip）：CI 用 setup-python 3.12 + requirements；
    // 本机用显式 MIST_PIPE_PYTHON / MIST_PIPE_PYTHONPATH。
    expect(
      python,
      "no python3.12/3.11 with starlette/pydantic/requests; set MIST_PIPE_PYTHON or CI setup-python + pip install -r assets/openwebui/requirements.txt",
    ).not.toBeNull();
    const pythonPath = pipePythonPath();
    const env = { ...process.env, ...(pythonPath === undefined ? {} : { PYTHONPATH: pythonPath }) };
    const result = spawnSync(python as string, [SCRIPT], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    const parsed = JSON.parse(line) as Record<string, boolean>;
    expect(parsed).toEqual({
      normal: true,
      last_user_only: true,
      bearer: true,
      task_refused: true,
      files_refused: true,
      interaction_refused: true,
      bad_shape: true,
      structured_refused: true,
      stream_one_done: true,
      canary_not_echoed: true,
      missing_token: true,
      untrusted_endpoint: true,
      valve_ignored: true,
      malformed_endpoint_refused: true,
      redirect_not_followed: true,
    });
    expect(result.status, output).toBe(0);
  });
});
