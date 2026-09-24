/**
 * RT-07 的静态判卷：一窗流、交接信、启动包都只有一条写入路径。
 *
 * 清单原文要求「全局检索确认……没有第二份写入路径（走 pi 扩展时同样适用）」，
 * 所以这盏灯不经驱动自述——驱动说自己没有第二份不算证据。本模块直接读源码树，
 * 回答一件可核事实：三样东西各自的唯一写入入口，在被检索的树里**恰好被调用一次**。
 *
 * 三样东西的唯一入口（真源分别是 D9 / D8 / acceptance/README.md C2）：
 *
 * 1. **一窗流** —— `CanonicalStreamWriter`。D9 一位住户一条权威生命线，
 *    底座 store 是唯一写方；第二个写句柄就是第二条生命线。
 * 2. **交接信** —— `sealLetter`。D8 交接信每代一封、当刻亲笔；第二个封缄口
 *    就是第二条能伪造签名的路。
 * 3. **启动包** —— `buildBootPack`。启动包必须由存储生成，不是手写文件；
 *    第二个装配器就是第二份住户身份真源。
 *
 * 检索根由调用方传入（可以是多个：`src/` 加上 pi 扩展目录），所以同一套判据既能
 * 指向真实源码树，也能在测试里指向夹具树做正对照——否则这盏灯只有红态可验，
 * 等于没验过。走 pi 扩展那条路线时把扩展目录一起传进来，藏在里面的第二份照样被抓。
 *
 * 能力边界（写明，不含糊）：本审计读的是源码文本，抓的是「写错或偷懒的实现」，
 * 抓不了存心用反射、动态 import 或字符串拼名字绕开检索的代码。按 D27 一，
 * 那类问题归代码评审与独立验收席。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** 三样东西各自的唯一写入入口标识符。 */
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

export type WriteSurfaceFindingKind =
  /** 唯一入口在树里一次都没被调用：这条路还没接线。 */
  | "write-path-missing"
  /** 唯一入口被调用多次：长出了第二份写入路径。 */
  | "write-path-duplicated";

export interface WriteSurfaceFinding {
  readonly kind: WriteSurfaceFindingKind;
  readonly surface: WritePathSurface;
  readonly detail: string;
}

export interface WritePathCallSite {
  /** 相对所在检索根的路径。 */
  readonly file: string;
  readonly line: number;
}

export interface WritePathAudit {
  readonly surface: WritePathSurface;
  readonly marker: string;
  readonly callSites: readonly WritePathCallSite[];
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

/**
 * 抹掉声明本身（`function sealLetter(` / `class CanonicalStreamWriter` 之类），
 * 只留调用点。声明不是写入路径，调用才是。
 */
function stripDeclarations(source: string, marker: string): string {
  const declaration = new RegExp(
    String.raw`(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+${marker}\b`,
    "g",
  );
  return source.replace(declaration, (match) => " ".repeat(match.length));
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

/** 统计一个标识符的**调用点**：`new 标识符` 或 `标识符(`，声明已抹掉。 */
function findCallSites(source: string, marker: string): number[] {
  const withoutDeclarations = stripDeclarations(source, marker);
  const invocation = new RegExp(String.raw`(?:new\s+${marker}\b|${marker}\s*\()`, "g");
  const lines: number[] = [];
  let match = invocation.exec(withoutDeclarations);
  while (match !== null) {
    lines.push(lineNumberAt(withoutDeclarations, match.index));
    match = invocation.exec(withoutDeclarations);
  }
  return lines;
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
    const callSites: WritePathCallSite[] = [];
    for (const { root, file } of files) {
      const source = stripCommentsAndStrings(readFileSync(file, "utf8"));
      for (const line of findCallSites(source, marker)) {
        callSites.push({ file: relative(root, file), line });
      }
    }

    paths.push({ surface, marker, callSites });

    if (callSites.length === 0) {
      findings.push({
        kind: "write-path-missing",
        surface,
        detail: `${roots.join("、")} 下没有任何 ${marker} 调用点：${surface} 的写入路径还没接线`,
      });
    }
    if (callSites.length > 1) {
      findings.push({
        kind: "write-path-duplicated",
        surface,
        detail: `${surface} 的写入入口 ${marker} 被调用 ${callSites.length} 次，长出了第二份写入路径：${callSites
          .map((site) => `${site.file}:${site.line}`)
          .join("、")}`,
      });
    }
  }

  return { roots, paths, findings };
}
