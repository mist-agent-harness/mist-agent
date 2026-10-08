import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { BreathTrigger } from "../../acceptance/resident-runtime-driver.ts";
import type { ResidentIdentityFailureReason } from "../resident-continuity/identity-store.ts";
import { parseManualBreath } from "../session/breath-trigger.ts";
import { assembleResidentRuntime } from "./assembly.ts";
import type { ModelTransport } from "./channels.ts";
import { CredentialStore } from "./credentials.ts";
import { ResidentChatTui } from "./tui.ts";
import {
  WebuiCliError,
  type WebuiEnvironmentReport,
  installWebui,
  preflightWebui,
} from "./webui-cli.ts";

/** 身份闸拒绝在终端边界的人话 message：保持与 runtime identityFailure 同一口径。 */
function identityFailureMessage(
  reason: ResidentIdentityFailureReason,
  referenceId: string,
): string {
  if (reason === "candidate-pending") return `候选住户尚未自认：${referenceId}`;
  if (reason === "candidate-rejected") return `候选住户已拒绝这份人格：${referenceId}`;
  return `没有 active resident：${referenceId}`;
}

/** 可操作 remedy；pending/rejected/missing 各给一条，不把三种塌成一句。 */
function identityFailureRemedy(reason: ResidentIdentityFailureReason): string {
  if (reason === "candidate-pending") {
    return "先完成这位 candidate 的 self-attestation；接受后再用返回的 residentId 进入运行时";
  }
  if (reason === "candidate-rejected") {
    return "停止普通聊天入口；如要重提，创建新的 persona candidate 并重新自认";
  }
  return "先创建 persona candidate，并由 candidate 本人接受后使用返回的 residentId（入住流程见 #182）";
}

interface ResidentCliOptions {
  readonly residentId: string;
  readonly dataDir: string;
  readonly help: boolean;
}

/**
 * 一条 CLI 输入的去向。命令不是发言（MV-D03）：`/new`、`/clear`、`/compact`
 * 走换气流程，绝不落进 `say()`，否则命令会被模型当成住户说的一句话。
 */
export type ResidentCliInput =
  | { readonly kind: "exit" }
  | { readonly kind: "breathe"; readonly via: BreathTrigger }
  | { readonly kind: "webui" }
  | { readonly kind: "chat"; readonly text: string };

/**
 * 把一行真实 CLI 输入分派到出口。`/exit` 是本层唯一的退出命令；三个换气命令
 * 经现役 `parseManualBreath` 归一（大小写、首尾空白、带参数形式同义），转成
 * 换气 `via`——D8 三个入口同一条流程，不在这里另认一套命令表。
 * `/webui` 是宿主前端管理入口，绝不作为发言落进 `say()`。
 */
export function parseResidentCliInput(line: string): ResidentCliInput {
  if (line.trim() === "/exit") return { kind: "exit" };
  if (line.trim() === "/webui") return { kind: "webui" };
  const trigger = parseManualBreath(line);
  if (trigger !== null && trigger.command !== null) {
    return { kind: "breathe", via: trigger.command.slice(1) as BreathTrigger };
  }
  return { kind: "chat", text: line };
}

export function parseResidentCliArguments(args: readonly string[]): ResidentCliOptions {
  let residentId: string | undefined;
  let dataDir = process.env.MIST_DATA_DIR ?? join(homedir(), ".mist");
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument !== "--resident" && argument !== "--data-dir") {
      throw new Error(`unknown resident option: ${argument ?? ""}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--resident") residentId = value;
    else dataDir = value;
    index += 1;
  }
  if (!help && (residentId === undefined || residentId.trim().length === 0)) {
    throw new Error("--resident is required; use --help for usage");
  }
  return { residentId: residentId ?? "", dataDir: resolve(dataDir), help };
}

export async function main(
  args = process.argv.slice(2),
  injection: {
    transport?: ModelTransport;
    webui?: {
      runner?: import("../frontend/webui-platform.ts").CommandRunner;
      newToken?: () => string;
      port?: number;
    };
  } = {},
): Promise<void> {
  const options = parseResidentCliArguments(args);
  if (options.help) {
    process.stdout.write(
      "Usage: npm run resident -- --resident <residentId> [--data-dir <path>]\n",
    );
    process.stdout.write("Type /exit to leave the single-resident chat.\n");
    process.stdout.write(
      "Type /new, /clear or /compact to breathe (commit a handover letter, start a new generation).\n",
    );
    return;
  }

  const runtime = assembleResidentRuntime({
    dataDir: options.dataDir,
    ...(injection.transport === undefined ? {} : { transport: injection.transport }),
  });
  try {
    // CLI 是宿主边界：candidateId 只在这里 resolve 一次，之后一律用 canonical
    // residentId。身份闸（D22 / #182）先于凭证面成立——安装器只保存了配置，没有
    // 住户自认，所以没有 active 住户时按 reason 机器可分地拒绝，不假装凭证问题：
    // candidate-pending / candidate-rejected / resident-not-found 三码各自成对。
    // 不 throw 崩溃：把 code/message/remedy 写进 stderr 后 return exitCode=1。
    const active = runtime.requireActiveResident(options.residentId);
    if (!active.ok) {
      const failure = {
        code: active.reason,
        message: identityFailureMessage(active.reason, options.residentId),
        remedy: identityFailureRemedy(active.reason),
        residentId: options.residentId,
      };
      process.stderr.write(`${failure.code}：${failure.message}\n处理建议：${failure.remedy}\n`);
      process.exitCode = 1;
      return;
    }
    const residentId = active.value.residentId;
    const credential = new CredentialStore(join(options.dataDir, "credentials")).find(residentId);
    const tui = new ResidentChatTui(runtime, {
      residentId,
      model: credential?.model ?? "未配置",
      onFrame: (frame) => {
        if (process.stdout.isTTY) process.stdout.write("\u001b[2J\u001b[H");
        process.stdout.write(`${frame.text}\n`);
      },
    });
    const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
    let interrupted = false;
    const onSigint = (): void => {
      interrupted = true;
      input.close();
    };
    process.once("SIGINT", onSigint);

    // `/webui` 与聊天共用同一条 stdin 的状态机：识别 /webui 立即 await 只读探测并展示
    // 提案，然后下一行归确认；EOF//exit/SIGINT 在任何阶段都取消待确认并清理。
    let webuiPhase: "idle" | "awaiting-confirm" = "idle";
    let pendingEnvironment: WebuiEnvironmentReport | null = null;
    let startedWebui: { url: string; close: () => Promise<void> } | null = null;
    const webuiDeps = {
      runtime,
      residentId,
      dataDir: options.dataDir,
      ...(injection.webui === undefined ? {} : injection.webui),
      log: (message: string) => process.stdout.write(`${message}\n`),
    };

    try {
      tui.start();
      process.stdout.write("输入 /exit 结束，/webui 安装可选网页前端。\n你> ");
      for await (const line of input) {
        // SIGINT/EOF 后即使还有缓冲行被 yield，也不得再进入安装/聊天。
        if (interrupted) break;
        // /exit 在任何阶段都结束：待确认直接取消，不落 say。
        if (line.trim() === "/exit") break;
        if (webuiPhase === "awaiting-confirm") {
          webuiPhase = "idle";
          const environment = pendingEnvironment;
          pendingEnvironment = null;
          if (interrupted) break;
          if (!/^\s*yes\s*$/i.test(line)) {
            process.stdout.write("已取消，未安装、未启动。\n你> ");
            continue;
          }
          if (environment === null) {
            process.stdout.write("环境信息丢失，已取消。\n你> ");
            continue;
          }
          process.stdout.write("安装并启动 Open WebUI 中…\n");
          const outcome = await installWebui(webuiDeps, environment);
          if (outcome.status === "started") {
            startedWebui = { url: outcome.url, close: outcome.close };
            process.stdout.write(`Open WebUI 已启动：${outcome.url}\n`);
            process.stdout.write(
              `管理登录用专属 admin 凭据：私有面 ${join(
                webuiDeps.dataDir,
                "webui",
                "credentials",
                "webui-admin.json",
              )}（本终端不回显密码）。\n`,
            );
          } else if (outcome.status === "missing-runtime") {
            process.stdout.write(`缺少运行环境：${outcome.missing.join("、")}；未安装、未启动。\n`);
          } else if (outcome.status === "failed") {
            process.stdout.write(`[${outcome.code}] ${outcome.remedy}\n`);
          }
          process.stdout.write("你> ");
          continue;
        }
        if (line.trim().length === 0) {
          process.stdout.write("\n你> ");
          continue;
        }
        const command = parseResidentCliInput(line);
        if (command.kind === "exit") break;
        if (command.kind === "webui") {
          if (startedWebui !== null) {
            process.stdout.write(`Open WebUI 已在运行：${startedWebui.url}\n你> `);
            continue;
          }
          if (webuiPhase !== "idle") {
            process.stdout.write("已有 /webui 正在处理，请先完成或取消。\n你> ");
            continue;
          }
          process.stdout.write("正在只读探测 Docker/Python…\n");
          const pre = await preflightWebui(webuiDeps);
          // 探测期间收到 SIGINT/EOF：丢弃取消路径，不展示确认也不安装。
          if (interrupted) break;
          if (!pre.ok) {
            process.stdout.write(`[${pre.code}] ${pre.remedy}\n你> `);
            continue;
          }
          process.stdout.write(`${pre.value.proposal}\n`);
          pendingEnvironment = pre.value.environment;
          webuiPhase = "awaiting-confirm";
          process.stdout.write("你> ");
          continue;
        }
        if (command.kind === "breathe") {
          // 换气命令不是发言：走 D8 的统一流程，绝不落进 say()。
          await tui.breathe(command.via);
        } else {
          await tui.submit(command.text);
        }
        process.stdout.write("\n你> ");
      }
    } finally {
      input.close();
      process.off("SIGINT", onSigint);
      // 先清前端服务与 listener，再由 owner finally 关闭 runtime；清理失败不吞。
      if (startedWebui !== null) {
        try {
          await startedWebui.close();
        } catch (error) {
          const code =
            error instanceof Error && error.name === "WebuiCliError"
              ? error.message
              : "WEBUI_CLEANUP_FAILED";
          const remedy =
            error instanceof WebuiCliError
              ? error.remedy
              : "前端清理失败；保留隔离态，请手动处理后重试。";
          process.stderr.write(`[${code}] ${remedy}\n`);
          process.exitCode = 1;
        }
      }
      if (interrupted) process.exitCode = 130;
    }
  } finally {
    await runtime.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown resident TUI failure";
    process.stderr.write(`Resident TUI failed: ${message}\n`);
    process.exitCode = 1;
  });
}
