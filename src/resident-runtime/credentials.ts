/**
 * #194 住户运行时的凭证面（RT-06「存了但没漏出」就落在这上面）。
 *
 * 口径照安装器（src/installer/state-store.ts）：密钥落 0600 私有文件、临时写
 * → fsync → 原子 rename；清单里只有引用（`mist-cred:<id>`），永远不写密钥原文。
 * RT-06 的扫描面是 日志 / 一窗流 / 交接信 / 启动包——凭证面不在其中：密钥就该
 * 住在这里，漏出去才算事故。密钥只在模型往返的那一刻经 readSecret 解析，
 * 原文不进任何返回值、不进事件、不进日志。
 *
 * `revoke` 只翻状态不删档：「没配过」（credential-missing）与「配过但失效」
 * （credential-invalid）必须机器可分（RT-01），删档会把两者塌成同一个空集。
 *
 * 代价：密钥以文件形态住在落盘根里，靠目录权限（0700/0600）兜底；不进系统
 * 钥匙串——那要引入跨平台外部依赖，等 #184 宿主契约定了宿主身份再说。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type ChannelCredentialStatus = "ready" | "revoked";

/** 清单条目：只有引用与元数据，没有密钥原文。 */
export interface ChannelCredentialRecord {
  readonly credentialRef: string;
  readonly residentId: string;
  readonly claudeSubscription: boolean;
  readonly credentialKind: "subscription" | "api-key";
  readonly model: string;
  readonly status: ChannelCredentialStatus;
}

interface CredentialManifest {
  readonly schemaVersion: 1;
  readonly credentials: ChannelCredentialRecord[];
}

const SAFE_CREDENTIAL_ID = /^[a-z0-9][a-z0-9._-]*$/;

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateFile(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留原始写入错误。
      }
    }
    rmSync(temporaryPath, { force: true, recursive: true });
    throw error;
  }
}

export class CredentialStore {
  readonly #rootDir: string;
  readonly #manifestPath: string;
  readonly #secretsDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
    this.#manifestPath = join(rootDir, "manifest.json");
    this.#secretsDir = join(rootDir, "secrets");
    mkdirSync(this.#secretsDir, { recursive: true, mode: 0o700 });
  }

  /**
   * 配一条通道凭证。同一住户重新配 = 换凭证：旧档连旧密钥一起删，
   * 「当前有效凭证」永远只有一份，不给「两条里挑一条能用的」留后门。
   */
  provision(input: {
    residentId: string;
    channel: {
      readonly claudeSubscription: boolean;
      readonly credentialKind: "subscription" | "api-key";
      readonly model: string;
    };
    secret: string;
  }): ChannelCredentialRecord {
    if (input.secret.length === 0) {
      throw new Error("credential secret must not be empty");
    }
    const credentialId = `cred-${randomUUID()}`;
    if (!SAFE_CREDENTIAL_ID.test(credentialId)) {
      throw new Error(`credential id 不可作为文件名: ${credentialId}`);
    }
    const record: ChannelCredentialRecord = {
      credentialRef: `mist-cred:${credentialId}`,
      residentId: input.residentId,
      claudeSubscription: input.channel.claudeSubscription,
      credentialKind: input.channel.credentialKind,
      model: input.channel.model,
      status: "ready",
    };
    // 密钥先落盘、清单后切换：任何时刻清单里引用的密钥文件都存在。
    writePrivateFile(this.#secretPath(record.credentialRef), input.secret);
    const previous = this.find(input.residentId);
    this.#writeManifest([
      ...this.#readManifest().credentials.filter(
        (candidate) => candidate.residentId !== input.residentId,
      ),
      record,
    ]);
    if (previous !== null) this.#forgetSecret(previous.credentialRef);
    return record;
  }

  /** 翻成 revoked，不删档：missing 与 invalid 两个失败码机器可分的前提。 */
  revoke(residentId: string): void {
    const record = this.find(residentId);
    if (record === null) return;
    this.#writeManifest(
      this.#readManifest().credentials.map((candidate) =>
        candidate.residentId === residentId ? { ...candidate, status: "revoked" } : candidate,
      ),
    );
  }

  find(residentId: string): ChannelCredentialRecord | null {
    return (
      this.#readManifest().credentials.find((candidate) => candidate.residentId === residentId) ??
      null
    );
  }

  /**
   * 调用时刻解析密钥原文。唯一消费方是模型适配器；原文不许再往下传给
   * 事件、日志、启动包或任何返回值（RT-06）。
   */
  readSecret(credentialRef: string): string {
    if (!credentialRef.startsWith("mist-cred:")) {
      throw new Error(`unexpected credential ref shape: ${credentialRef}`);
    }
    return readFileSync(this.#secretPath(credentialRef), "utf8");
  }

  /** 凭证面自身的落盘根（RT-06 扫描面刻意不含这里——密钥本就该住这儿）。 */
  get rootDir(): string {
    return this.#rootDir;
  }

  #secretPath(credentialRef: string): string {
    const credentialId = credentialRef.slice("mist-cred:".length);
    if (!SAFE_CREDENTIAL_ID.test(credentialId)) {
      throw new Error(`credential id 不可作为文件名: ${credentialId}`);
    }
    return join(this.#secretsDir, `${credentialId}.key`);
  }

  #forgetSecret(credentialRef: string): void {
    rmSync(this.#secretPath(credentialRef), { force: true });
  }

  #readManifest(): CredentialManifest {
    try {
      const parsed = JSON.parse(readFileSync(this.#manifestPath, "utf8")) as CredentialManifest;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.credentials)) {
        throw new Error("credential manifest has an unsupported shape");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, credentials: [] };
      }
      throw error;
    }
  }

  #writeManifest(credentials: readonly ChannelCredentialRecord[]): void {
    const manifest: CredentialManifest = { schemaVersion: 1, credentials: [...credentials] };
    writePrivateFile(this.#manifestPath, JSON.stringify(manifest, null, 2));
  }
}
