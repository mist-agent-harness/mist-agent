import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiInteractiveLogin } from "../src/installer/pi-login.ts";
import { providerById } from "../src/installer/providers.ts";

const temporaryDirectories: string[] = [];

function freshAuthPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-pi-login-"));
  temporaryDirectories.push(directory);
  return join(directory, "auth.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi interactive OAuth", () => {
  it("returns only an opaque locator after Pi owns the OAuth exchange", async () => {
    const authPath = freshAuthPath();
    writeFileSync(authPath, JSON.stringify({ "openai-codex": { access: "sensitive-token" } }));
    const launch = vi.fn(async () => undefined);
    const messages: string[] = [];
    const login = new PiInteractiveLogin({
      authPath,
      launch,
      beforeLaunch: (message) => messages.push(message),
    });

    const receipt = await login.login(providerById("codex"));

    expect(receipt).toEqual({ locator: "pi-auth://openai-codex" });
    expect(JSON.stringify({ receipt, messages })).not.toContain("sensitive-token");
    expect(launch).toHaveBeenCalledOnce();
  });

  it("keeps the draft incomplete when Pi exits without the selected provider", async () => {
    const authPath = freshAuthPath();
    writeFileSync(authPath, JSON.stringify({ anthropic: {} }));
    const login = new PiInteractiveLogin({
      authPath,
      launch: async () => undefined,
      beforeLaunch: () => undefined,
    });

    await expect(login.login(providerById("codex"))).rejects.toThrow(/without a Codex credential/);
  });

  it("does not launch a dead OAuth path for Grok", async () => {
    const launch = vi.fn(async () => undefined);
    const login = new PiInteractiveLogin({ authPath: freshAuthPath(), launch });

    await expect(login.login(providerById("grok"))).rejects.toThrow(/does not expose OAuth/);
    expect(launch).not.toHaveBeenCalled();
  });
});
