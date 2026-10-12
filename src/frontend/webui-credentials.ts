/**
 * D31-1 WebUI 专属管理凭据的**私有面**：随机生成一次性 dedicated admin 邮箱/密码，只落在
 * 专属私有目录（0700）与文件（0600），exclusive create，重启复用同一份；**绝不**进 argv/URL/
 * 日志/公开 config/操作账/proposal/模板，也绝不覆写既有用户凭据或 DB。
 *
 * 安全拒绝：符号链接、非普通文件、组/他人可读权限、损坏 JSON、缺字段。任何异常都抛稳定
 * `WebuiCredentialError`，不留半写文件、不静默降级成明文或默认口令。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";

export class WebuiCredentialError extends Error {
  readonly code: string;
  readonly remedy: string;
  constructor(code: string, remedy: string) {
    super(code);
    this.name = "WebuiCredentialError";
    this.code = code;
    this.remedy = remedy;
  }
}

export interface WebuiAdminCredentials {
  readonly email: string;
  readonly password: string;
}

const CREDENTIALS_DIR = "credentials";
const CREDENTIALS_FILE = "webui-admin.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function fail(remedy: string): never {
  throw new WebuiCredentialError("WEBUI_CREDENTIAL_UNSAFE", remedy);
}

/** 目录必须是我们建的私有目录：存在则校验非 symlink 且权限不宽于 0700。 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) fail("WebUI 凭据目录是符号链接；已拒绝读取/写入，请手动处理该路径。");
  if (!stat.isDirectory()) fail("WebUI 凭据路径不是目录；已拒绝写入，请手动处理。");
  const groupOrOther = stat.mode & 0o077;
  if (groupOrOther !== 0) fail("WebUI 凭据目录权限过宽（非 0700）；已拒绝读取，请先收紧权限。");
  chmodSync(dir, DIR_MODE);
}

/** 读取既有私有凭据；严格拒绝 symlink/非普通文件/权限过宽/损坏/缺字段。 */
function readCredentials(file: string): WebuiAdminCredentials | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    return null; // 尚不存在
  }
  if (stat.isSymbolicLink()) fail("WebUI 凭据文件是符号链接；已拒绝读取，请手动处理。");
  if (!stat.isFile()) fail("WebUI 凭据路径不是普通文件；已拒绝读取。");
  if ((stat.mode & 0o077) !== 0) fail("WebUI 凭据文件权限过宽（非 0600）；已拒绝读取，请先收紧。");
  const fd = openSync(file, "r");
  let raw: string;
  try {
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    raw = buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("WebUI 凭据文件损坏（非法 JSON）；已拒绝覆写，请手动处理该文件。");
  }
  if (typeof parsed !== "object" || parsed === null) fail("WebUI 凭据内容无效；已拒绝使用。");
  const record = parsed as Record<string, unknown>;
  const { email, password } = record;
  if (
    typeof email !== "string" ||
    email.length === 0 ||
    typeof password !== "string" ||
    password.length === 0
  )
    fail("WebUI 凭据内容缺字段；已拒绝使用。");
  return { email, password };
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** exclusive create（wx）：并发下只允许一个成功；已存在由调用方按既有文件复用。 */
function writeCredentials(file: string, creds: WebuiAdminCredentials): void {
  const payload = JSON.stringify(creds);
  const fd = openSync(file, "wx", FILE_MODE);
  try {
    writeSync(fd, payload, null, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(file, FILE_MODE);
}

/**
 * 载入或一次性生成专属 admin 凭据；重启读同一份（不换 password，避免既有 DB 登录失败）。
 * `email` 与 `password` 都只用作 WebUI 官方 `WEBUI_ADMIN_EMAIL/PASSWORD` 与内存 signin。
 */
export function loadOrCreateAdminCredentials(dataDir: string): WebuiAdminCredentials {
  const dir = join(dataDir, CREDENTIALS_DIR);
  ensurePrivateDir(dir);
  const file = join(dir, CREDENTIALS_FILE);
  const existing = readCredentials(file);
  if (existing !== null) return existing;
  const creds: WebuiAdminCredentials = {
    email: `mist-admin-${randomToken(8)}@mist.local`,
    password: randomToken(32),
  };
  try {
    writeCredentials(file, creds);
  } catch {
    // 并发或其它写失败：若此刻已有合法文件则复用，否则如实报错。
    const raced = readCredentials(file);
    if (raced !== null) return raced;
    throw new WebuiCredentialError(
      "WEBUI_CREDENTIAL_WRITE_FAILED",
      "生成专属 WebUI 管理凭据失败；未启动服务，请检查私有目录权限后重试。",
    );
  }
  return creds;
}
