/**
 * RT-07 静态审计的单元测试。
 *
 * 这个审计是本 PR 里唯一有逻辑的生产件（判卷自己也要被判），所以它的每个判据
 * 都要有正反两侧的用例：既能报出问题，也不冤枉干净的树。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WRITE_PATH_MARKERS,
  WRITE_PATH_SURFACES,
  auditResidentRuntimeWriteSurface,
} from "../acceptance/resident-runtime-write-surface.ts";

let fixtureRoot: string;

function writeTree(root: string, files: Readonly<Record<string, string>>): string {
  const full = join(fixtureRoot, root);
  mkdirSync(full, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const target = join(full, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  return full;
}

const DECLARATIONS = `export class CanonicalStreamWriter {
  submit() {}
}
export function sealLetter(draft) {
  return draft;
}
export function buildBootPack(store, residentId) {
  return residentId;
}
`;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "mist-rt07-unit-"));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("auditResidentRuntimeWriteSurface", () => {
  it("三个唯一入口各调用一次时零 findings——声明本身不算调用点", () => {
    const root = writeTree("clean", {
      "assemble.ts": `${DECLARATIONS}
export function assemble() {
  const writer = new CanonicalStreamWriter();
  const letter = sealLetter({});
  const pack = buildBootPack({}, "r");
  return { writer, letter, pack };
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toEqual([]);
    for (const surface of WRITE_PATH_SURFACES) {
      const path = report.paths.find((item) => item.surface === surface);
      expect(path?.callSites).toHaveLength(1);
    }
  });

  it("注释和字符串里的同名词不算调用点", () => {
    const root = writeTree("noisy", {
      "assemble.ts": `${DECLARATIONS}
// 一个 new CanonicalStreamWriter 也不许再有。
const README = "sealLetter(sealLetter(sealLetter(";
export function assemble() {
  const writer = new CanonicalStreamWriter();
  const letter = sealLetter({});
  const pack = buildBootPack({}, "r");
  return { writer, letter, pack };
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toEqual([]);
  });

  it("零调用时三个面各报 write-path-missing", () => {
    const root = writeTree("idle", {
      "idle.ts": `${DECLARATIONS}
export function assemble() {
  return null;
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "write-path-missing",
      "write-path-missing",
      "write-path-missing",
    ]);
    expect(report.findings.map((finding) => finding.surface)).toEqual(WRITE_PATH_SURFACES);
  });

  it("同一根里两个调用点判 write-path-duplicated，并点到文件和行号", () => {
    const root = writeTree("double", {
      "a.ts": `export class CanonicalStreamWriter {
  submit() {}
}
export function first() {
  new CanonicalStreamWriter();
}
`,
      "b.ts": `export function second() {
  new CanonicalStreamWriter();
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    const finding = report.findings.find(
      (item) => item.kind === "write-path-duplicated" && item.surface === "one-stream",
    );
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("a.ts:5");
    expect(finding?.detail).toContain("b.ts:2");
  });

  it("第二个写入路径藏进 pi 扩展根照样被判——「走 pi 扩展时同样适用」", () => {
    const half = `${DECLARATIONS}
export function partial() {
  new CanonicalStreamWriter();
  sealLetter({});
  buildBootPack({}, "r");
}
`;
    const srcRoot = writeTree("src-fixture", { "host.ts": half });
    const extensionRoot = writeTree("pi-extension", { "extension.ts": half });

    const alone = auditResidentRuntimeWriteSurface([srcRoot]);
    expect(alone.findings).toEqual([]);

    const withExtension = auditResidentRuntimeWriteSurface([srcRoot, extensionRoot]);
    for (const surface of WRITE_PATH_SURFACES) {
      const finding = withExtension.findings.find(
        (item) => item.kind === "write-path-duplicated" && item.surface === surface,
      );
      expect(finding, `${surface} 的第二份没被判出来`).toBeDefined();
      expect(finding?.detail).toContain("extension.ts");
      expect(finding?.detail).toContain("host.ts");
    }
  });

  it("三个面的标记各是唯一写入入口的名字", () => {
    expect(WRITE_PATH_MARKERS["one-stream"]).toBe("CanonicalStreamWriter");
    expect(WRITE_PATH_MARKERS["handover-letter"]).toBe("sealLetter");
    expect(WRITE_PATH_MARKERS["boot-pack"]).toBe("buildBootPack");
  });

  it("检索空目录时三个面全 missing，不抛错", () => {
    const root = writeTree("empty-dir", { "keep.ts": "export const x = 1;\n" });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toHaveLength(WRITE_PATH_SURFACES.length);
  });
});
