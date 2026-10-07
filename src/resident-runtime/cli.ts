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
  /**
   * 显式重试：复用上一条失败回合的锚与原文，不是「同文本再发一遍」。
   * 普通输入（含与失败回合同文本）照常是**新回合**。
   */
  | { readonly kind: "retry" }
  | { readonly kind: "breathe"; readonly via: BreathTrigger }
  | { readonly kind: "chat"; readonly text: string };

/**
 * 把一行真实 CLI 输入分派到出口。`/exit` 是本层唯一的退出命令；三个换气命令
 * 经现役 `parseManualBreath` 归一（大小写、首尾空白、带参数形式同义），转成
 * 换气 `via`——D8 三个入口同一条流程，不在这里另认一套命令表。
 */
export function parseResidentCliInput(line: string): ResidentCliInput {
  if (line.trim() === "/exit") return { kind: "exit" };
  if (line.trim() === "/retry") return { kind: "retry" };
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
  injection: { transport?: ModelTransport } = {},
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
    process.stdout.write("Type /retry to retry the last failed turn under its original anchor.\n");
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

    try {
      tui.start();
      process.stdout.write("输入 /exit 结束。\n你> ");
      for await (const line of input) {
        const command = parseResidentCliInput(line);
        if (command.kind === "exit") break;
        if (line.trim().length === 0) {
          process.stdout.write("\n你> ");
          continue;
        }
        if (command.kind === "breathe") {
          // 换气命令不是发言：走 D8 的统一流程，绝不落进 say()。
          await tui.breathe(command.via);
        } else if (command.kind === "retry") {
          // 显式重试：复用失败回合的锚与原文，不落成新回合。
          await tui.retry();
        } else {
          await tui.submit(command.text);
        }
        process.stdout.write("\n你> ");
      }
    } finally {
      input.close();
      process.off("SIGINT", onSigint);
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
