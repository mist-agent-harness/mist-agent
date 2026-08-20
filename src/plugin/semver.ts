/**
 * 插件协议 v0 的严格 SemVer 小子集 —— 故意小，故意严。
 *
 * RFC §2 把话说死了：「未知的……版本范围语法都必须按不兼容拒装，不得猜默认值」。
 * 所以这里不引第三方 semver 依赖，只实现一个明确列举的子集；任何不在列举内的
 * 语法一律解析失败，由调用方按 HOST_INCOMPATIBLE 拒装——拒绝就是协议要的答案，
 * 不是实现偷懒。
 *
 * 支持的版本形态：完整 `X.Y.Z`，可带 `-prerelease`（点分标识符）与 `+build`（忽略参与比较）。
 * 支持的 range 语法：以空格分隔的 AND 比较器序列，每个比较器为
 *   `X.Y.Z`（精确）| `=X.Y.Z` | `>=X.Y.Z` | `>X.Y.Z` | `<=X.Y.Z` | `<X.Y.Z` | `^X.Y.Z` | `~X.Y.Z`
 * 不支持（即拒绝）：`||`、x-range（`1.x`/`*`）、连字符区间、部分版本（`1.2`）、`v` 前缀。
 * 将来要放宽，改这里并同步 RFC 措辞，不在调用点散写。
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * 数字标识符安全门：超过 Number.MAX_SAFE_INTEGER 的数字段一律拒绝解析——
 * 否则 9007199254740992 与 9007199254740993 会折叠成同一个 major，requiresMist 的
 * 精确/边界比较随之误判（②段互审反例一）。拒绝仍是子集哲学：不猜、不折叠。
 */
function safeNumericIdentifier(text: string): number | null {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/** 严格解析完整 SemVer；不合形态或数字段超安全整数返回 null，绝不猜。 */
export function parseSemVer(input: string): SemVer | null {
  const m = VERSION_RE.exec(input);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    return null;
  }
  const major = safeNumericIdentifier(m[1]);
  const minor = safeNumericIdentifier(m[2]);
  const patch = safeNumericIdentifier(m[3]);
  if (major === null || minor === null || patch === null) {
    return null;
  }
  const prerelease: (string | number)[] = [];
  if (m[4] !== undefined) {
    for (const part of m[4].split(".")) {
      if (/^(0|[1-9]\d*)$/.test(part)) {
        const n = safeNumericIdentifier(part);
        if (n === null) {
          return null;
        }
        prerelease.push(n);
      } else {
        prerelease.push(part);
      }
    }
  }
  return { major, minor, patch, prerelease };
}

/** SemVer 精确优先级比较：负=a<b，0=相等，正=a>b。含 prerelease 规则（spec §11）。 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // 无 prerelease 高于有 prerelease
  if (bp.length === 0) return -1;
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === y) continue;
    const xn = typeof x === "number";
    const yn = typeof y === "number";
    if (xn && yn) return (x as number) - (y as number);
    if (xn) return -1; // 数字标识符低于字母
    if (yn) return 1;
    return (x as string) < (y as string) ? -1 : 1;
  }
  return ap.length - bp.length;
}

type Comparator = {
  readonly op: "=" | ">=" | ">" | "<=" | "<" | "^" | "~";
  readonly version: SemVer;
};

/** 解析 range；任何未列举语法返回 null（= 调用方拒装）。 */
export function parseRange(input: string): readonly Comparator[] | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const comparators: Comparator[] = [];
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(part);
    if (m === null || m[2] === undefined) {
      return null;
    }
    const version = parseSemVer(m[2]);
    if (version === null) {
      return null; // 含部分版本、x-range、v 前缀等一律视为未知语法
    }
    comparators.push({ op: (m[1] as Comparator["op"]) ?? "=", version });
  }
  return comparators;
}

function satisfiesComparator(v: SemVer, c: Comparator): boolean {
  const cmp = compareSemVer(v, c.version);
  switch (c.op) {
    case "=":
      return cmp === 0;
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "^": {
      if (cmp < 0) return false;
      // ^ 允许不改变最左非零位的升级
      if (c.version.major > 0) return v.major === c.version.major;
      if (c.version.minor > 0) return v.major === 0 && v.minor === c.version.minor;
      return v.major === 0 && v.minor === 0 && v.patch === c.version.patch;
    }
    case "~": {
      if (cmp < 0) return false;
      return v.major === c.version.major && v.minor === c.version.minor;
    }
  }
}

/** 版本是否满足 range（AND 语义）。range 未知语法应在 parseRange 就拒掉，此处不再宽容。 */
export function satisfies(version: SemVer, range: readonly Comparator[]): boolean {
  return range.every((c) => satisfiesComparator(version, c));
}
