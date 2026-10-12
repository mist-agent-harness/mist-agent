/**
 * D31-1 real-main child fixture: sets up an active resident + injected recording transport and
 * a fake (delayed) command runner, then runs the real CLI `main` over piped stdin. The test
 * drives /webui + confirmation + chat and inspects which texts the model actually received.
 * All synthetic; no private paths/credentials.
 */
import { writeFileSync } from "node:fs";
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "../../src/frontend/webui-platform.ts";
import { assembleResidentRuntime } from "../../src/resident-runtime/assembly.ts";
import type {
  ModelCompletionRequest,
  ModelTransport,
} from "../../src/resident-runtime/channels.ts";
import { main } from "../../src/resident-runtime/cli.ts";

const dataDir = process.argv[2];
const recordPath = process.argv[3];
if (dataDir === undefined || recordPath === undefined)
  throw new Error("usage: <dataDir> <recordPath>");

const setup = assembleResidentRuntime({ dataDir });
const candidate = setup.createCandidate({
  persona: "persona:resident-webui",
  proposedBy: { kind: "installer", id: "fixture" },
  residentId: "resident-webui",
});
setup.attestCandidate(
  candidate.candidateId,
  { kind: "candidate", candidateId: candidate.candidateId },
  "accepted",
);
const active = setup.requireActiveResident("resident-webui");
if (!active.ok) throw new Error("resident not active");
const residentId = active.value.residentId;
await setup.provisionChannel({
  residentId,
  channel: { claudeSubscription: false, credentialKind: "api-key", model: "pi-test/model" },
  canarySecret: "canary",
});
await setup.close();

class RecordingTransport implements ModelTransport {
  async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
    writeFileSync(recordPath as string, `${JSON.stringify(request.text)}\n`, { flag: "a" });
    yield "ok";
  }
}

class DelayRunner implements CommandRunner {
  readonly live = new Set<string>();
  async run(invocation: CommandInvocation): Promise<CommandResult> {
    await new Promise((resolve) => setTimeout(resolve, 30)); // readonly envprobe 延迟
    if (invocation.file === "docker" && invocation.args[0] === "info")
      return { code: 1, stdout: "", stderr: "" };
    if (invocation.args.includes("--version"))
      return { code: 0, stdout: "", stderr: "Python 3.12.13" };
    if (invocation.args.some((a) => a.includes("/health")))
      return { code: 0, stdout: '{"status":true}\n200', stderr: "" };
    if (invocation.args.some((a) => a.includes("/models")))
      return { code: 0, stdout: "401\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async startContainer(invocation: CommandInvocation & { name: string }) {
    this.live.add(invocation.name);
    return { containerId: `cid-${invocation.name}` };
  }
  async startProcess(invocation: CommandInvocation & { name: string }) {
    this.live.add(invocation.name);
    return { pid: 1 };
  }
  async stopContainer(name: string) {
    this.live.delete(name);
  }
  async stopProcess(name: string) {
    this.live.delete(name);
  }
  async isProcessAlive() {
    return true;
  }
}

await main(["--resident", residentId, "--data-dir", dataDir], {
  transport: new RecordingTransport(),
  webui: { runner: new DelayRunner(), port: 0 },
});
