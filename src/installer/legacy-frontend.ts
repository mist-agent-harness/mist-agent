/**
 * FE-01 旧 `official-skin` 前端配置的 fail-closed 读取。
 *
 * 旧安装器只在草稿/快照里落过 `{ kind: "official-skin", installation: "pending" }` 留桩；
 * D31 删掉该桩后，任何真实旧 draft/config 在**读取**（`InstallerStateStore.loadDraft` /
 * `loadCurrentConfig`）时就返回稳定 `LEGACY_FRONTEND_UNSUPPORTED` 与可操作 remedy，
 * 原字节一动不动，绝不静默迁成 `terminal` 或 `external`。
 */
export const LEGACY_FRONTEND_UNSUPPORTED = "LEGACY_FRONTEND_UNSUPPORTED";

export const LEGACY_FRONTEND_REMEDY =
  "The official-skin frontend was a placeholder and is no longer supported. Back up the legacy draft/config and move it aside (never edit it in place), then run setup again and choose either 'Terminal only (default)' or 'Connect my own OpenAI-compatible frontend'.";

export const INSTALL_CONFIG_UNREADABLE = "MIST_INSTALL_CONFIG_UNREADABLE";

export const INSTALL_CONFIG_UNREADABLE_REMEDY =
  "This installer draft/config cannot be parsed as JSON. Back it up and move it aside (never edit it in place), then run setup again explicitly.";

export class LegacyFrontendUnsupportedError extends Error {
  readonly code = LEGACY_FRONTEND_UNSUPPORTED;
  readonly remedy: string;
  constructor(remedy: string = LEGACY_FRONTEND_REMEDY) {
    super(remedy);
    this.name = "LegacyFrontendUnsupportedError";
    this.remedy = remedy;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只读判定：给定 draft/config 的 frontend 字段是不是旧 official-skin 形状。 */
export function isLegacyFrontend(value: unknown): boolean {
  return isRecord(value) && value.kind === "official-skin";
}

export interface LegacyFrontendReadback {
  ok: boolean;
  code: string;
  remedy: string;
  rewritten: boolean;
  bytesAfter: string;
}

/** 面向任意原始配置字节的只读判定；不写盘、不改字节。解析失败同样 fail-closed。 */
export function readLegacyOfficialSkin(rawConfig: string): LegacyFrontendReadback {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    // 与 store 的 fail-closed 语义一致：读不懂的字节不当作可用配置。
    return {
      ok: false,
      code: INSTALL_CONFIG_UNREADABLE,
      remedy: INSTALL_CONFIG_UNREADABLE_REMEDY,
      rewritten: false,
      bytesAfter: rawConfig,
    };
  }
  if (!(isRecord(parsed) && isLegacyFrontend(parsed.frontend))) {
    return { ok: true, code: "", remedy: "", rewritten: false, bytesAfter: rawConfig };
  }
  return {
    ok: false,
    code: LEGACY_FRONTEND_UNSUPPORTED,
    remedy: LEGACY_FRONTEND_REMEDY,
    rewritten: false,
    bytesAfter: rawConfig,
  };
}
