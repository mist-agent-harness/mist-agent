import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { ResidentIdentityFailureReason } from "../resident-continuity/identity-store.ts";
import { CredentialStore } from "./credentials.ts";
import { ResidentRuntime } from "./runtime.ts";
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseResidentCliArguments(args);
  if (options.help) {
    process.stdout.write(
      "Usage: npm run resident -- --resident <residentId> [--data-dir <path>]\n",
    );
    process.stdout.write("Type /exit to leave the single-resident chat.\n");
    return;
  }

  const runtime = new ResidentRuntime({ dataDir: options.dataDir });
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
        if (line.trim() === "/exit") break;
        if (line.trim().length === 0) {
          process.stdout.write("\n你> ");
          continue;
        }
        await tui.submit(line);
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
