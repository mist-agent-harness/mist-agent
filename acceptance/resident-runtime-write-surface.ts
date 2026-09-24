/**
 * RT-07 的静态判卷：一窗流、交接信、启动包各只有一份写入路径。
 *
 * 清单原文要求「全局检索确认……没有第二份写入路径（走 pi 扩展时同样适用）」，
 * 所以这盏灯不经驱动自述——驱动说自己没有第二份不算证据。本模块直接读源码树。
 *
 * ## 判什么：定义唯一，不是调用唯一
 *
 * 「一份写入路径」的机器形式是**那份实现恰好被定义一次**。三样东西的唯一实现：
 *
 * 1. **一窗流** —— `CanonicalStreamWriter`。D9 一位住户一条权威生命线，底座 store
 *    是唯一写方。运行时构造写句柄几次是合法的（不同 data root / 不同宿主），所以
 *    数的是**类定义**，不是 `new` 出现几次；同一进程同一 data root 只能有一个写句柄
 *    由 `WriterOwnershipError` 在运行时兜住，不归本审计。
 * 2. **交接信** —— `sealLetter`。D8 交接信每代一封、当刻亲笔；封缄口只能有一个。
 *    换几代办几封信都合法，所以数的也是**函数定义**。
 * 3. **启动包** —— `buildBootPack`。启动包必须由存储生成、由唯一装配器生成；它是纯读
 *    函数，醒来要调、换代后要调、各路驱动也要调，所以**调用次数天然不唯一**，数的是
 *    **函数定义**。
 *
 * 按定义判的三个直接后果（都写明，不含糊）：
 *
 * - **别名调用不算第二份**。`import { buildBootPack as assembleBootPack }` 之后调
 *   `assembleBootPack(...)`，复用的是同一个装配器，本来就不构成第二条写入路径。
 * - **方法门面不算第二份**。类上叫 `buildBootPack` 的包装方法（如
 *   `src/acceptance-driver.ts` 的 P3 门面）不是一份新装配器，它只是接线层的一格。
 * - **pi 扩展里另起一份同名副本会被抓到**。这正是 D28 二「不在 pi 里另起一份副本」
 *   的机器形式——检索根可以是多个（`src/` 加扩展目录），两处定义就判红。
 *
 * 检索根由调用方传入，所以同一套判据既能指向真实源码树，也能在测试里指向夹具树做
 * 正对照——否则这盏灯只有红态可验，等于没验过。
 *
 * 能力边界（写明，不含糊）：本审计读源码文本、按标识符认实现，抓的是「写错或偷懒的
 * 实现」和「同名副本」。抓不了换个名字另写一份的实现（比如手搓一个 `SealedLetter`
 * 对象字面量、或直接写 `*.stream.json`），也抓不了用反射、动态 import、字符串拼名字
 * 绕开检索的代码。按 D27 一，那类问题归代码评审与独立验收席。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** 三样东西各自的唯一实现标识符。 */
export const WRITE_PATH_MARKERS = {
  /** D9：一窗流唯一写方。 */
  "one-stream": "CanonicalStreamWriter",
  /** D8：交接信唯一封缄口。 */
  "handover-letter": "sealLetter",
  /** 启动包唯一装配器（由存储生成，不是手写文件）。 */
  "boot-pack": "buildBootPack",
} as const;

export type WritePathSurface = keyof typeof WRITE_PATH_MARKERS;

export const WRITE_PATH_SURFACES = Object.keys(WRITE_PATH_MARKERS) as WritePathSurface[];

/**
 * 认「定义」的关键词。**不含方法声明**——类方法没有这些前缀词，正好不会被当成一份
 * 新实现；`async buildBootPack(...)`、`private sealLetter(...)` 之类的门面因此被正确
 * 忽略，而 `function buildBootPack(...)` / `class CanonicalStreamWriter` 会被认到。
 */
const DECLARATION_KEYWORDS = [
  "class",
  "function",
  "const",
  "let",
  "var",
  "interface",
  "type",
  "enum",
] as const;

export type WriteSurfaceFindingKind =
  /** 唯一实现在树里一次都没定义：没接线，或检索根指错了地方。 */
  | "write-path-missing"
  /** 唯一实现在树里被定义多次：长出了第二份（含 pi 扩展里的同名副本）。 */
  | "write-path-duplicated";

export interface WriteSurfaceFinding {
  readonly kind: WriteSurfaceFindingKind;
  readonly surface: WritePathSurface;
  readonly detail: string;
}

export interface WritePathDefinitionSite {
  /** 相对所在检索根的路径。 */
  readonly file: string;
  readonly line: number;
  /** 命中的是哪个声明关键词，评审时可直接看出这算不算一份实现。 */
  readonly keyword: string;
}

export interface WritePathAudit {
  readonly surface: WritePathSurface;
  readonly marker: string;
  readonly definitions: readonly WritePathDefinitionSite[];
}

export interface ResidentRuntimeWriteSurfaceReport {
  readonly roots: readonly string[];
  readonly paths: readonly WritePathAudit[];
  readonly findings: readonly WriteSurfaceFinding[];
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", "webui"]);

/**
 * 去掉注释与字符串字面量内容，避免文档注释里的词被当成源码事实。
 * 字符串留下空壳（引号保留、内容清空），这样长度与行号不漂。
 */
function stripCommentsAndStrings(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        // 保留换行，行号不漂。
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      output += char;
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      output += char;
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function collectTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full);
    }
  };
  walk(root);
  return files;
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

/**
 * 找出一个标识符的**定义**：`class 标识符` / `function 标识符(` / `const 标识符` 之类。
 *
 * `export` / `declare` / `abstract` / `default` 这些修饰词可有可无。`\b` 保证
 * `CanonicalStreamWriterOptions` 不会被 `CanonicalStreamWriter` 认成一次定义。
 */
function findDeclarationSites(source: string, marker: string): { line: number; keyword: string }[] {
  const keywordGroup = DECLARATION_KEYWORDS.join("|");
  const pattern = new RegExp(
    String.raw`(?:export\s+|declare\s+|abstract\s+|default\s+|async\s+)*(?:${keywordGroup})\s+${marker}\b`,
    "g",
  );
  const sites: { line: number; keyword: string }[] = [];
  let match = pattern.exec(source);
  while (match !== null) {
    // 先把命中片段和位置取出来再进回调——闭包里的 `match` 收窄不到非空。
    const matched = match[0];
    const at = match.index;
    const keyword = DECLARATION_KEYWORDS.find((candidate) =>
      new RegExp(String.raw`(?:^|\s)${candidate}\s+${marker}\b$`).test(matched),
    );
    sites.push({ line: lineNumberAt(source, at), keyword: keyword ?? "?" });
    match = pattern.exec(source);
  }
  return sites;
}

export function auditResidentRuntimeWriteSurface(
  sourceRoots: readonly string[],
): ResidentRuntimeWriteSurfaceReport {
  const roots = sourceRoots.map((root) => resolve(root));
  const files: { readonly root: string; readonly file: string }[] = [];
  for (const root of roots) {
    for (const file of collectTypeScriptFiles(root)) files.push({ root, file });
  }

  const paths: WritePathAudit[] = [];
  const findings: WriteSurfaceFinding[] = [];

  for (const surface of WRITE_PATH_SURFACES) {
    const marker = WRITE_PATH_MARKERS[surface];
    const definitions: WritePathDefinitionSite[] = [];
    for (const { root, file } of files) {
      const source = stripCommentsAndStrings(readFileSync(file, "utf8"));
      for (const site of findDeclarationSites(source, marker)) {
        definitions.push({
          file: relative(root, file),
          line: site.line,
          keyword: site.keyword,
        });
      }
    }

    paths.push({ surface, marker, definitions });

    const where = definitions.map((site) => `${site.file}:${site.line}`).join("、");
    if (definitions.length === 0) {
      findings.push({
        kind: "write-path-missing",
        surface,
        detail: `${roots.join("、")} 下没有任何 ${marker} 的实现定义：要么这条路还没接线，要么检索根指错了地方`,
      });
    }
    if (definitions.length > 1) {
      findings.push({
        kind: "write-path-duplicated",
        surface,
        detail: `${surface} 的实现 ${marker} 被定义 ${definitions.length} 次（${where}），长出了第二份写入路径——含 pi 扩展里的同名副本`,
      });
    }
  }

  return { roots, paths, findings };
}
