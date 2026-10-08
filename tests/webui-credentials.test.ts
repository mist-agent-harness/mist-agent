/**
 * D31-1 私有管理凭据面测试：0700/0600、随机生成、重启复用、拒绝 symlink/过宽权限/损坏/缺字段，
 * 且绝不覆写既有合法凭据。
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WebuiCredentialError,
  loadOrCreateAdminCredentials,
} from "../src/frontend/webui-credentials.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-webui-cred-"));
  dirs.push(dir);
  return dir;
}
function credFile(dataDir: string): string {
  return join(dataDir, "credentials", "webui-admin.json");
}

describe("#218 WebUI admin credentials private face", () => {
  it("generates random credentials in a 0700 dir / 0600 file and reuses them", () => {
    const dataDir = temp();
    const first = loadOrCreateAdminCredentials(dataDir);
    expect(first.email).toContain("@mist.local");
    expect(first.password.length).toBeGreaterThanOrEqual(32);
    expect(statSync(join(dataDir, "credentials")).mode & 0o777).toBe(0o700);
    expect(statSync(credFile(dataDir)).mode & 0o777).toBe(0o600);
    const second = loadOrCreateAdminCredentials(dataDir);
    expect(second).toEqual(first);
  });

  it("does not overwrite a pre-existing valid credential file", () => {
    const dataDir = temp();
    const dir = join(dataDir, "credentials");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const existing = { email: "kept@mist.local", password: "kept-password" };
    writeFileSync(credFile(dataDir), JSON.stringify(existing), { mode: 0o600 });
    expect(loadOrCreateAdminCredentials(dataDir)).toEqual(existing);
    expect(JSON.parse(readFileSync(credFile(dataDir), "utf8"))).toEqual(existing);
  });

  it("rejects a symlinked credential file", () => {
    const dataDir = temp();
    const dir = join(dataDir, "credentials");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const target = join(dataDir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ email: "a", password: "b" }));
    symlinkSync(target, credFile(dataDir));
    expect(() => loadOrCreateAdminCredentials(dataDir)).toThrowError(WebuiCredentialError);
  });

  it("rejects an over-permissive credential file", () => {
    const dataDir = temp();
    const dir = join(dataDir, "credentials");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(credFile(dataDir), JSON.stringify({ email: "a@mist.local", password: "b" }), {
      mode: 0o600,
    });
    chmodSync(credFile(dataDir), 0o644);
    expect(() => loadOrCreateAdminCredentials(dataDir)).toThrowError(/WEBUI_CREDENTIAL_UNSAFE/);
  });

  it("rejects a corrupt credential file without overwriting it", () => {
    const dataDir = temp();
    const dir = join(dataDir, "credentials");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(credFile(dataDir), "{not-json", { mode: 0o600 });
    expect(() => loadOrCreateAdminCredentials(dataDir)).toThrowError(WebuiCredentialError);
    expect(readFileSync(credFile(dataDir), "utf8")).toBe("{not-json");
  });
});
