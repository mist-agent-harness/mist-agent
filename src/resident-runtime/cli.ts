import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { BreathTrigger } from "../../acceptance/resident-runtime-driver.ts";
import { parseManualBreath } from "../session/breath-trigger.ts";
import { assembleResidentRuntime } from "./assembly.ts";
import type { ModelTransport } from "./channels.ts";
import { CredentialStore } from "./credentials.ts";
import { ResidentChatTui } from "./tui.ts";

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
  | { readonly kind: "chat"; readonly text: string };

/**
 * 把一行真实 CLI 输入分派到出口。`/exit` 是本层唯一的退出命令；三个换气命令
 * 经现役 `parseManualBreath` 归一（大小写、首尾空白、带参数形式同义），转成
 * 换气 `via`——D8 三个入口同一条流程，不在这里另认一套命令表。
 */
export function parseResidentCliInput(line: string): ResidentCliInput {
  if (line.trim() === "/exit") return { kind: "exit" };
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
    return;
  }

  const runtime = assembleResidentRuntime({
    dataDir: options.dataDir,
    ...(injection.transport === undefined ? {} : { transport: injection.transport }),
  });
  try {
    const active = runtime.requireActiveResident(options.residentId);
    if (!active.ok) throw new Error(active.reason);
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
