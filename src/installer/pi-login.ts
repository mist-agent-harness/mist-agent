import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderCapability } from "./providers.ts";

export interface OAuthLoginReceipt {
  /** Opaque locator only. Token/access/refresh values never cross this interface. */
  locator: string;
}

export interface OAuthLoginPort {
  login(provider: ProviderCapability): Promise<OAuthLoginReceipt>;
}

export interface PiInteractiveLoginOptions {
  command?: string;
  authPath?: string;
  beforeLaunch?: (message: string) => void;
  /** Test seam; production defaults to spawning the configured Pi command. */
  launch?: () => Promise<void>;
}

function runInteractive(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pi login process exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

/** Launches Pi as the OAuth owner, then confirms only that the selected auth key exists. */
export class PiInteractiveLogin implements OAuthLoginPort {
  readonly #command: string;
  readonly #authPath: string;
  readonly #beforeLaunch: (message: string) => void;
  readonly #launch: () => Promise<void>;

  constructor(options: PiInteractiveLoginOptions = {}) {
    this.#command = options.command ?? "pi";
    this.#authPath = options.authPath ?? join(homedir(), ".pi", "agent", "auth.json");
    this.#beforeLaunch =
      options.beforeLaunch ?? ((message) => process.stdout.write(`${message}\n`));
    this.#launch = options.launch ?? (() => runInteractive(this.#command));
  }

  async login(provider: ProviderCapability): Promise<OAuthLoginReceipt> {
    if (!provider.methods.includes("oauth")) {
      throw new Error(`${provider.label} does not expose OAuth through Pi`);
    }
    this.#beforeLaunch(
      `Pi will open now. Run /login, choose ${provider.label}, finish authorization, then quit Pi.`,
    );
    await this.#launch();
    const auth = JSON.parse(await readFile(this.#authPath, "utf8")) as Record<string, unknown>;
    if (!Object.hasOwn(auth, provider.piAuthKey)) {
      throw new Error(
        `Pi exited without a ${provider.label} credential in its auth store; the installer draft was kept`,
      );
    }
    return { locator: `pi-auth://${provider.piAuthKey}` };
  }
}
