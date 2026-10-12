/**
 * FE-05/FE-07 私有附件面（真实 byte/read/commit 语义 + 授权边界）。
 *
 * - 入站：`prepare()` 只签元数据；`persist()` 在模型成功后才落真实字节。
 * - 出站：**新 ID 只由宿主生成器签发**（生产默认随机 opaque，验收 driver 可注入固定
 *   ID 生成器）；调用方不能自带 ID。复用既有引用走 `reuseOutbound()` 独立授权路径，
 *   未知 ID 不会变成新文件。
 * - 所有 ID 作安全校验（拒 `..`、绝对路径、路径分隔符等），写/读路径均再核一次。
 * - 暂存只存**字节与元数据快照**，返回快照副本；模型改 Buffer/对象不影响已验证内容；
 *   读取返回副本。整条 reply 通过且回合成功才 `commitStaged()`；失败/未引用则丢弃。
 * - 读字节只经受限句柄回给受信 port；读回口只给 opaque 元数据，不回字节。
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StructuredAttachment } from "../../acceptance/frontend-adapter-driver.ts";

export interface AttachmentOwner {
  bindingId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  writerId: string;
}

export interface AttachmentWriteRecord extends StructuredAttachment, AttachmentOwner {}

export interface AttachmentWriteReadback {
  count: number;
  records: AttachmentWriteRecord[];
}

export interface IngressAttachmentSpec {
  kind: "image" | "file";
  filename: string;
  mediaType: string;
  source: "inline" | "opaque-ref";
  bytes: Buffer | null;
}

export interface PreparedAttachment {
  attachment: StructuredAttachment;
  bytes: Buffer | null;
}

/** 出站新附件请求：**不含 ID**——ID 由宿主生成器签发。 */
export interface OutboundAttachmentInput {
  kind: "image" | "file";
  filename: string;
  mediaType: string;
  bytes: Buffer;
}

export interface AttachmentReadHandle {
  readonly attachment: StructuredAttachment;
  read(): Promise<Buffer>;
}

export interface AttachmentVaultOptions {
  /** 宿主出站 ID 生成器；生产默认随机 opaque。 */
  newOutboundId?: (owner: AttachmentOwner) => string;
  maxAttachmentBytes?: number;
}

export const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;

/** ID 安全校验：拒空、`..`、`/`、`\`、绝对路径、过长或可疑格式。 */
export function assertSafeAttachmentId(id: string): void {
  if (!SAFE_ATTACHMENT_ID.test(id) || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error(`unsafe attachment id rejected: ${JSON.stringify(id)}`);
  }
}

export function imageContentMatches(mediaType: string, bytes: Buffer): boolean {
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) return false;
  switch (mediaType) {
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"));
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
        bytes.subarray(8, 12).toString("latin1") === "WEBP"
      );
    default:
      return false;
  }
}

function freezeAttachment(attachment: StructuredAttachment): StructuredAttachment {
  return Object.freeze({ ...attachment });
}

interface Staged {
  attachment: StructuredAttachment;
  bytes: Buffer;
  owner: AttachmentOwner;
}

export class AttachmentVault {
  readonly #directory: string;
  readonly #newOutboundId: (owner: AttachmentOwner) => string;
  readonly #maxBytes: number;
  #records: AttachmentWriteRecord[] = [];
  readonly #staged = new Map<string, Staged>();

  constructor(rootDir: string, options: AttachmentVaultOptions = {}) {
    this.#directory = join(rootDir, "attachments");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    this.#newOutboundId = options.newOutboundId ?? (() => `att_${randomUUID()}`);
    this.#maxBytes = options.maxAttachmentBytes ?? 4 * 1024 * 1024;
  }

  prepare(spec: IngressAttachmentSpec): PreparedAttachment {
    const attachment = freezeAttachment({
      attachmentId: `att_${randomUUID()}`,
      kind: spec.kind,
      filename: spec.filename,
      mediaType: spec.mediaType,
      sizeBytes: spec.bytes?.length ?? 0,
      source: spec.source,
    });
    return { attachment, bytes: spec.bytes === null ? null : Buffer.from(spec.bytes) };
  }

  persist(prepared: PreparedAttachment, owner: AttachmentOwner): StructuredAttachment {
    assertSafeAttachmentId(prepared.attachment.attachmentId);
    const bytes = prepared.bytes === null ? null : Buffer.from(prepared.bytes);
    if (bytes !== null) this.#writeBytes(prepared.attachment.attachmentId, bytes);
    this.#records.push({ ...prepared.attachment, ...owner });
    return freezeAttachment(prepared.attachment);
  }

  /** 新出站：ID 由宿主生成器签发；只暂存快照，不落盘不登记。 */
  issueOutbound(input: OutboundAttachmentInput, owner: AttachmentOwner): StructuredAttachment {
    const id = this.#newOutboundId(owner);
    assertSafeAttachmentId(id);
    if (this.#staged.has(id) || this.#records.some((record) => record.attachmentId === id)) {
      throw new Error(`outbound attachment id already exists: ${id}`);
    }
    const bytes = Buffer.from(input.bytes);
    if (bytes.length > this.#maxBytes)
      throw new Error("outbound attachment exceeds the size limit");
    if (input.kind === "image" && !imageContentMatches(input.mediaType, bytes)) {
      throw new Error("outbound image content does not match its declared media type");
    }
    const attachment = freezeAttachment({
      attachmentId: id,
      kind: input.kind,
      filename: input.filename,
      mediaType: input.mediaType,
      sizeBytes: bytes.length,
      source: "inline",
    });
    this.#staged.set(id, { attachment, bytes, owner });
    return attachment;
  }

  /** 复用同户已有合法引用：未知 ID 不会变新文件；owner/metadata/bytes 逐项一致才放行。 */
  reuseOutbound(
    refId: string,
    input: OutboundAttachmentInput,
    owner: AttachmentOwner,
  ): StructuredAttachment {
    assertSafeAttachmentId(refId);
    const existing = this.#records.find((record) => record.attachmentId === refId);
    if (existing === undefined) throw new Error(`unknown outbound ref: ${refId}`);
    const stored = this.readBytes(refId);
    if (
      existing.bindingId !== owner.bindingId ||
      existing.residentId !== owner.residentId ||
      existing.scopeId !== owner.scopeId ||
      existing.kind !== input.kind ||
      existing.filename !== input.filename ||
      existing.mediaType !== input.mediaType ||
      existing.sizeBytes !== input.bytes.length ||
      stored === null ||
      !stored.equals(input.bytes)
    ) {
      throw new Error(`outbound ref ${refId} does not match the existing private attachment`);
    }
    return freezeAttachment({
      attachmentId: existing.attachmentId,
      kind: existing.kind,
      filename: existing.filename,
      mediaType: existing.mediaType,
      sizeBytes: existing.sizeBytes,
      source: existing.source,
    });
  }

  commitStaged(ids: readonly string[]): void {
    for (const id of ids) {
      const staged = this.#staged.get(id);
      if (staged === undefined) continue;
      this.#writeBytes(id, staged.bytes);
      this.#records.push({ ...staged.attachment, ...staged.owner });
      this.#staged.delete(id);
    }
  }

  discardStaged(ids: readonly string[]): void {
    for (const id of ids) this.#staged.delete(id);
  }

  isStaged(id: string): boolean {
    return this.#staged.has(id);
  }

  stagedOwner(id: string): AttachmentOwner | null {
    return this.#staged.get(id)?.owner ?? null;
  }

  lookup(attachmentId: string): AttachmentWriteRecord | undefined {
    if (!SAFE_ATTACHMENT_ID.test(attachmentId)) return undefined;
    return this.#records.find((record) => record.attachmentId === attachmentId);
  }

  /** 读字节：暂存读快照副本，既有读磁盘副本；只回副本，外部改动不影响私有面。 */
  readBytes(attachmentId: string): Buffer | null {
    if (!SAFE_ATTACHMENT_ID.test(attachmentId)) return null;
    const staged = this.#staged.get(attachmentId);
    if (staged !== undefined) return Buffer.from(staged.bytes);
    if (!this.#records.some((record) => record.attachmentId === attachmentId)) return null;
    try {
      return readFileSync(join(this.#directory, `${attachmentId}.bin`));
    } catch {
      return null;
    }
  }

  readback(): AttachmentWriteReadback {
    return { count: this.#records.length, records: structuredClone(this.#records) };
  }

  reset(): void {
    this.#records = [];
    this.#staged.clear();
  }

  #writeBytes(attachmentId: string, bytes: Buffer): void {
    assertSafeAttachmentId(attachmentId);
    const target = join(this.#directory, `${attachmentId}.bin`);
    writeFileSync(target, bytes, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
}
