/**
 * WH-06 的静态判卷：写入路径唯一。
 *
 * 清单原文要求「代码检索与类型检查」，所以这盏灯不经驱动自述——驱动说自己没有
 * 写入口不算证据。本模块直接读源码树，回答三件可核事实：
 *
 * 1. 生产 port 类型上除 `summarize` / `read` 之外有没有别的成员；
 * 2. 生产组装里构造底座写句柄（`CanonicalStreamWriter`）的模块是不是唯一一处；
 * 3. 承载 port 的那个模块目录有没有自带写入路径——既不许持有 writer，
 *    也不许自己动落盘写系统调用。
 *
 * 检索根由调用方传入，所以同一套判据既能指向真实 `src/`，也能在测试里指向
 * 夹具树做正对照——否则这盏灯只有红态可验，等于没验过。
 *
 * 能力边界（写明，不含糊）：本审计读的是源码文本，抓的是「写错或偷懒的实现」，
 * 抓不了存心用反射、动态 import 或字符串拼名字绕开检索的代码。按 D27 一，
 * 那类问题归代码评审与独立验收席。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** port 上唯一允许的两个成员。 */
export const ALLOWED_PORT_MEMBERS = ["read", "summarize"] as const;

/** 底座写句柄的类型名——先决①定的唯一写方。 */
const WRITER_TYPE = "CanonicalStreamWriter";

/** 落盘写系统调用：projection 目录里出现任何一个都说明它自带写入路径。 */
const DURABLE_WRITE_CALLS = [
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "openSync",
  "writeSync",
  "renameSync",
  "rename",
  "rmSync",
  "unlinkSync",
  "mkdirSync",
  "createWriteStream",
  "ftruncateSync",
] as const;

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", "webui"]);

export type WriteSurfaceFindingKind =
  | "port-missing"
  | "port-duplicated"
  | "port-has-extra-member"
  | "writer-missing"
  | "writer-duplicated"
  | "projection-holds-writer"
  | "projection-writes-durable-bytes";

export interface WriteSurfaceFinding {
  readonly kind: WriteSurfaceFindingKind;
  readonly detail: string;
}

export interface PortDeclaration {
  /** 相对检索根的路径。 */
  readonly file: string;
  readonly typeName: string;
  readonly members: readonly string[];
}

export interface WriteSurfaceAudit {
  readonly portDeclarations: readonly PortDeclaration[];
  readonly writerConstructionSites: readonly string[];
  readonly projectionFiles: readonly string[];
  readonly findings: readonly WriteSurfaceFinding[];
}

/**
 * 去掉注释与字符串字面量内容，避免文档注释里的词被当成源码事实。
 * 字符串留下空壳（引号保留、内容清空），这样长度与结构不乱。
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

/** 从 `{` 起做括号配平，取出声明体。找不到配对时返回 null。 */
function balancedBody(source: string, openBraceIndex: number): string | null {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, index);
    }
  }
  return null;
}

/** 把嵌套层的文本抹成空格，只留顶层成员，供切分成员名用。 */
function flattenNested(body: string): string {
  let depth = 0;
  let output = "";
  for (const char of body) {
    if (char === "{" || char === "(" || char === "[" || char === "<") {
      depth += 1;
      output += depth === 1 ? char : " ";
      continue;
    }
    if (char === "}" || char === ")" || char === "]" || char === ">") {
      output += depth === 1 ? char : " ";
      depth = Math.max(0, depth - 1);
      continue;
    }
    output += depth === 0 ? char : " ";
  }
  return output;
}

function memberNames(body: string): string[] {
  const flattened = flattenNested(body);
  const names: string[] = [];
  for (const fragment of flattened.split(/[;\n,]/)) {
    const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*[(:<]/.exec(fragment);
    if (match !== null && match[1] !== undefined) names.push(match[1]);
  }
  return [...new Set(names)].sort();
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

function findPortDeclarations(root: string, file: string, source: string): PortDeclaration[] {
  const declarations: PortDeclaration[] = [];
  const pattern = /(?:interface|type)\s+([A-Za-z0-9_$]*WindowHistoryPort)\b/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const typeName = match[1] ?? "";
    const openBraceIndex = source.indexOf("{", match.index);
    const body = openBraceIndex === -1 ? null : balancedBody(source, openBraceIndex);
    declarations.push({
      file: relative(root, file),
      typeName,
      members: body === null ? [] : memberNames(body),
    });
    match = pattern.exec(source);
  }
  return declarations;
}

export function auditWindowHistoryWriteSurface(sourceRoot: string): WriteSurfaceAudit {
  const root = resolve(sourceRoot);
  const files = collectTypeScriptFiles(root);
  const sources = new Map<string, string>();
  for (const file of files) sources.set(file, stripCommentsAndStrings(readFileSync(file, "utf8")));

  const portDeclarations: PortDeclaration[] = [];
  const writerConstructionSites: string[] = [];
  for (const [file, source] of sources) {
    portDeclarations.push(...findPortDeclarations(root, file, source));
    if (source.includes(`new ${WRITER_TYPE}`)) writerConstructionSites.push(relative(root, file));
  }

  const projectionDirectories = new Set(
    portDeclarations.map((declaration) => dirname(join(root, declaration.file))),
  );
  const projectionFiles = files
    .filter((file) => projectionDirectories.has(dirname(file)))
    .map((file) => relative(root, file));

  const findings: WriteSurfaceFinding[] = [];
  if (portDeclarations.length === 0) {
    findings.push({
      kind: "port-missing",
      detail: `检索根 ${root} 下没有任何 *WindowHistoryPort 声明：生产 port 还没落地`,
    });
  }
  if (portDeclarations.length > 1) {
    findings.push({
      kind: "port-duplicated",
      detail: `发现 ${portDeclarations.length} 处 port 声明：${portDeclarations
        .map((declaration) => `${declaration.file}:${declaration.typeName}`)
        .join("、")}`,
    });
  }
  for (const declaration of portDeclarations) {
    const extras = declaration.members.filter(
      (member) => !ALLOWED_PORT_MEMBERS.includes(member as (typeof ALLOWED_PORT_MEMBERS)[number]),
    );
    const missing = ALLOWED_PORT_MEMBERS.filter((member) => !declaration.members.includes(member));
    if (extras.length > 0) {
      findings.push({
        kind: "port-has-extra-member",
        detail: `${declaration.file}:${declaration.typeName} 除 summarize/read 外还有成员：${extras.join("、")}`,
      });
    }
    if (missing.length > 0) {
      findings.push({
        kind: "port-has-extra-member",
        detail: `${declaration.file}:${declaration.typeName} 缺成员：${missing.join("、")}`,
      });
    }
  }
  if (writerConstructionSites.length === 0) {
    findings.push({
      kind: "writer-missing",
      detail: `生产组装里没有任何 new ${WRITER_TYPE} 调用点：唯一写方还没接线`,
    });
  }
  if (writerConstructionSites.length > 1) {
    findings.push({
      kind: "writer-duplicated",
      detail: `构造 ${WRITER_TYPE} 的模块不唯一：${writerConstructionSites.join("、")}`,
    });
  }
  for (const file of projectionFiles) {
    const source = sources.get(join(root, file)) ?? "";
    if (source.includes(WRITER_TYPE)) {
      findings.push({
        kind: "projection-holds-writer",
        detail: `${file} 引用了 ${WRITER_TYPE}：projection 不许持有底座写句柄`,
      });
    }
    const writeCalls = DURABLE_WRITE_CALLS.filter((call) => source.includes(`${call}(`));
    if (writeCalls.length > 0) {
      findings.push({
        kind: "projection-writes-durable-bytes",
        detail: `${file} 自带落盘写调用：${writeCalls.join("、")}`,
      });
    }
  }

  return { portDeclarations, writerConstructionSites, projectionFiles, findings };
}
