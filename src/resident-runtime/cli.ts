import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CredentialStore } from "./credentials.ts";
import { ResidentRuntime } from "./runtime.ts";
import { ResidentChatTui } from "./tui.ts";

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

  const credential = new CredentialStore(join(options.dataDir, "credentials")).find(
    options.residentId,
  );
  const runtime = new ResidentRuntime({ dataDir: options.dataDir });
  const tui = new ResidentChatTui(runtime, {
    residentId: options.residentId,
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
    await runtime.close();
    if (interrupted) process.exitCode = 130;
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
