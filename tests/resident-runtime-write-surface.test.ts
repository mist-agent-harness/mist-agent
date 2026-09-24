/**
 * RT-07 静态审计的单元测试。
 *
 * 这个审计是本 PR 里唯一有逻辑的生产件（判卷自己也要被判），所以它的每个判据
 * 都要有正反两侧的用例：既能报出问题，也不冤枉干净的树。
 *
 * 前四条是 #200 审读第 2 条的**回归钉子**——它指出的假红（方法声明被数成调用点）
 * 和假绿（别名调用看不见）曾经同时开着，这里钉死。
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

/** 三个唯一实现各定义一次。 */
const THREE_DEFINITIONS = `export class CanonicalStreamWriter {
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
  it("回归钉：类上的方法门面不算第二份实现（#200 审读第 2 条的假红）", () => {
    // `src/acceptance-driver.ts:317` 就是这样一门 `async buildBootPack(residentId)`。
    // 按调用点判会把它数成一次「调用」，运行时再真调一次就假红；按定义判它不是实现。
    const root = writeTree("facade", {
      "impl.ts": THREE_DEFINITIONS,
      "harness.ts": `export class Harness {
  async buildBootPack(residentId) {
    return assembleBootPack({}, residentId);
  }
  sealLetter(draft) {
    return draft;
  }
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toEqual([]);
    const bootPack = report.paths.find((path) => path.surface === "boot-pack");
    expect(bootPack?.definitions).toHaveLength(1);
  });

  it("回归钉：别名调用复用同一实现，不算第二份（#200 审读第 2 条的假绿方向）", () => {
    const root = writeTree("aliased", {
      "impl.ts": THREE_DEFINITIONS,
      // `src/acceptance-driver.ts:23` 就是 `import { buildBootPack as assembleBootPack }`，
      // 真调用在 :321 走别名。复用同一个装配器，本来就不构成第二条写入路径。
      "driver.ts": `import { buildBootPack as assembleBootPack } from "./impl.ts";
export class Driver {
  async buildBootPack(residentId) {
    return assembleBootPack({}, residentId);
  }
  async again(residentId) {
    return assembleBootPack({}, residentId);
  }
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toEqual([]);
  });

  it("调用多少次都不影响唯一性——启动包是纯读函数，调用次数天然不唯一", () => {
    const root = writeTree("many-calls", {
      "impl.ts": `${THREE_DEFINITIONS}
export function wake(residentId) {
  buildBootPack({}, residentId);
  buildBootPack({}, residentId);
  sealLetter({});
  sealLetter({});
  new CanonicalStreamWriter();
  new CanonicalStreamWriter();
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toEqual([]);
  });

  it("注释和字符串里的同名词不算定义", () => {
    const root = writeTree("noisy", {
      "impl.ts": `${THREE_DEFINITIONS}
// 一份 function sealLetter 也不许再有。
const README = "buildBootPack(buildBootPack(buildBootPack(";
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toEqual([]);
  });

  it("零定义时三个面各报 write-path-missing", () => {
    const root = writeTree("idle", {
      "idle.ts": `export function assemble() {
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

  it("同一根里两处定义判 write-path-duplicated，点到文件和行号", () => {
    const root = writeTree("double", {
      "a.ts": `export function sealLetter(draft) {
  return draft;
}
`,
      "b.ts": `export function sealLetter(draft) {
  return draft;
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    const finding = report.findings.find(
      (item) => item.kind === "write-path-duplicated" && item.surface === "handover-letter",
    );
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("a.ts:1");
    expect(finding?.detail).toContain("b.ts:1");
  });

  it("第二份定义藏进 pi 扩展根照样被判——「走 pi 扩展时同样适用」", () => {
    const srcRoot = writeTree("src-fixture", { "host.ts": THREE_DEFINITIONS });
    const extensionRoot = writeTree("pi-extension", { "extension.ts": THREE_DEFINITIONS });

    const alone = auditResidentRuntimeWriteSurface([srcRoot]);
    expect(alone.findings).toEqual([]);

    const withExtension = auditResidentRuntimeWriteSurface([srcRoot, extensionRoot]);
    for (const surface of WRITE_PATH_SURFACES) {
      const finding = withExtension.findings.find(
        (item) => item.kind === "write-path-duplicated" && item.surface === surface,
      );
      expect(finding, `${surface} 的同名副本没被判出来`).toBeDefined();
      expect(finding?.detail).toContain("extension.ts");
      expect(finding?.detail).toContain("host.ts");
    }
  });

  it("词边界：CanonicalStreamWriterOptions 不算 CanonicalStreamWriter 的定义", () => {
    const root = writeTree("boundary", {
      "impl.ts": `export interface CanonicalStreamWriterOptions {
  readonly x: number;
}
export class CanonicalStreamWriter {
  submit() {}
}
export function sealLetter(draft) {
  return draft;
}
export function buildBootPack(store, residentId) {
  return residentId;
}
`,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.findings).toEqual([]);
    const oneStream = report.paths.find((path) => path.surface === "one-stream");
    expect(oneStream?.definitions).toHaveLength(1);
    expect(oneStream?.definitions[0]?.keyword).toBe("class");
  });

  it("报告带上命中的是哪个声明关键词，评审能看出这算不算一份实现", () => {
    const root = writeTree("keywords", {
      "impl.ts": THREE_DEFINITIONS,
    });

    const report = auditResidentRuntimeWriteSurface([root]);

    expect(report.paths.map((path) => path.definitions[0]?.keyword)).toEqual([
      "class",
      "function",
      "function",
    ]);
  });

  it("三个面的标记各是唯一实现的名字", () => {
    expect(WRITE_PATH_MARKERS["one-stream"]).toBe("CanonicalStreamWriter");
    expect(WRITE_PATH_MARKERS["handover-letter"]).toBe("sealLetter");
    expect(WRITE_PATH_MARKERS["boot-pack"]).toBe("buildBootPack");
  });
});
