import { anthropicMessagesAdapter } from "./adapters/anthropic.ts";
import { openAiChatCompletionsAdapter } from "./adapters/openai.ts";
import { createPersistentDemoRuntime } from "./runtime.ts";
import { createDemoServer } from "./server.ts";

interface CliOptions {
  dataDir: string;
  port: number;
}

function usage(): string {
  return "Usage: npm run demo -- --data-dir <directory> [--port <0-65535>]";
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer from 0 through 65535");
  }
  return port;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let dataDir = process.env.MIST_DEMO_DATA_DIR ?? "";
  let port = parsePort(process.env.MIST_DEMO_PORT ?? "4317");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--data-dir") {
      dataDir = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--port") {
      port = parsePort(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (dataDir.trim().length === 0) throw new Error("--data-dir is required");
  return { dataDir, port };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtime = await createPersistentDemoRuntime({
    dataDir: options.dataDir,
    reply: async (_residentId, message) => `Mist 演示回应：${message}`,
  });
  const server = createDemoServer({
    runtime,
    adapters: [openAiChatCompletionsAdapter, anthropicMessagesAdapter],
  });
  const address = await server.start(options.port);
  const { residentId } = runtime.inspect();
  process.stdout.write(
    `${JSON.stringify({ ok: true, host: address.address, port: address.port, residentId })}\n`,
  );

  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
