import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectedWindowHistoryCheckIds,
  windowHistoryChecks,
} from "../acceptance/window-history-checks.ts";
import type { WindowHistoryDriver } from "../acceptance/window-history-driver.ts";
import {
  type WriteSurfaceFindingKind,
  auditWindowHistoryWriteSurface,
} from "../acceptance/window-history-write-surface.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wh-write-surface-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function findingKinds(root: string): WriteSurfaceFindingKind[] {
  return auditWindowHistoryWriteSurface(root).findings.map((finding) => finding.kind);
}

const conformingPort = `
export interface MistWindowHistoryPort {
  summarize(window: WindowHistoryRef): Promise<Result<WindowHistorySummary>>;
  read(
    window: WindowHistoryRef,
    page: { beforeSeq: number | null; maxMessages: number | null },
  ): Promise<Result<WindowHistoryPage>>;
}
`;

const conformingWriterOwner = `
import { CanonicalStreamWriter } from "./one-stream/writer.ts";
export const writer = new CanonicalStreamWriter(store);
`;

function conformingTree(omit: readonly string[] = []): Record<string, string> {
  const all: Record<string, string> = {
    "window-history/port.ts": conformingPort,
    "window-history/projection.ts": "export const projection = 1;\n",
    "composition/host.ts": conformingWriterOwner,
  };
  return Object.fromEntries(Object.entries(all).filter(([path]) => !omit.includes(path)));
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("#120 window-history acceptance contract", () => {
  it("freezes all six check ids in order without duplicates", () => {
    const ids = windowHistoryChecks.map((check) => check.id);
    expect(ids).toEqual([...expectedWindowHistoryCheckIds]);
    expect(new Set(ids).size).toBe(6);
  });

  it("keeps every executable check paired with one unchecked lamp in the markdown", () => {
    const markdown = readFileSync(join(repoRoot, "acceptance/window-history.md"), "utf8");
    for (const id of expectedWindowHistoryCheckIds) {
      expect(markdown, `${id} should own an unchecked lamp`).toContain(`- [ ] **${id} `);
      expect(markdown, `${id} must not be pre-lit in the list`).not.toContain(`- [x] **${id} `);
    }
    expect(markdown).not.toContain("- [x]");
  });

  it("declares only real driver methods and cleans up after every integration lamp", () => {
    // 与驱动契约同步：漏改一个名字就编译不过，而不是悄悄判错灯。
    const methodNames = new Set<keyof WindowHistoryDriver>([
      "reset",
      "startHost",
      "killHost",
      "hostDescriptor",
      "openWindow",
      "appendWindowEvent",
      "appendWindowEventsConcurrently",
      "rotateGeneration",
      "archiveWindow",
      "writerIdentity",
      "summarize",
      "read",
      "injectStorageReadFailure",
      "clearStorageReadFailure",
      "deleteDurableWindowData",
      "corruptDurableEntry",
      "durableSnapshot",
      "migrationState",
      "migrateStorageFormat",
      "rollbackStorageFormat",
      "interruptMigration",
      "resumeMigration",
      "readTombstones",
    ]);

    for (const check of windowHistoryChecks) {
      for (const method of check.uses) {
        expect(methodNames.has(method), `${check.id} uses unknown method ${method}`).toBe(true);
      }
      if (check.id === "WH-06") {
        // 静态灯不经驱动观察：它自述用了驱动方法反而是错的。
        expect(check.uses).toEqual([]);
        continue;
      }
      expect(check.uses, `${check.id} must reset`).toContain("reset");
      expect(check.uses.length).toBeGreaterThan(1);
    }
  });
});

describe("WH-06 write-surface audit", () => {
  it("passes a tree with one read-only port and one writer owner", () => {
    expect(findingKinds(fixtureTree(conformingTree()))).toEqual([]);
  });

  it("catches a write method smuggled onto the port", () => {
    const tree = conformingTree();
    tree["window-history/port.ts"] = conformingPort.replace(
      "  read(",
      "  append(entry: WindowHistoryEntry): Promise<void>;\n  read(",
    );
    expect(findingKinds(fixtureTree(tree))).toContain("port-has-extra-member");
  });

  it("catches a port that lost one of its two read members", () => {
    const tree = conformingTree();
    tree["window-history/port.ts"] = `
export interface MistWindowHistoryPort {
  read(window: WindowHistoryRef): Promise<Result<WindowHistoryPage>>;
}
`;
    expect(findingKinds(fixtureTree(tree))).toContain("port-has-extra-member");
  });

  it("catches a second port declaration", () => {
    const tree = conformingTree();
    tree["window-history/legacy-port.ts"] = conformingPort.replace(
      "MistWindowHistoryPort",
      "LegacyWindowHistoryPort",
    );
    expect(findingKinds(fixtureTree(tree))).toContain("port-duplicated");
  });

  it("reports a missing production port", () => {
    const tree = conformingTree(["window-history/port.ts"]);
    expect(findingKinds(fixtureTree(tree))).toContain("port-missing");
  });

  it("reports a missing and a duplicated writer owner", () => {
    const withoutWriter = conformingTree(["composition/host.ts"]);
    expect(findingKinds(fixtureTree(withoutWriter))).toContain("writer-missing");

    const twoWriters = conformingTree();
    twoWriters["composition/second-host.ts"] = conformingWriterOwner;
    expect(findingKinds(fixtureTree(twoWriters))).toContain("writer-duplicated");
  });

  it("catches a projection that holds the substrate write handle", () => {
    const tree = conformingTree();
    tree["window-history/projection.ts"] =
      'import type { CanonicalStreamWriter } from "../one-stream/writer.ts";\nexport type Held = CanonicalStreamWriter;\n';
    expect(findingKinds(fixtureTree(tree))).toContain("projection-holds-writer");
  });

  it("catches a projection that writes durable bytes itself", () => {
    const tree = conformingTree();
    tree["window-history/projection.ts"] =
      'import { writeFileSync } from "node:fs";\nexport const save = (): void => writeFileSync("x", "y");\n';
    expect(findingKinds(fixtureTree(tree))).toContain("projection-writes-durable-bytes");
  });

  it("does not trip on write words that only appear in comments or strings", () => {
    const tree = conformingTree();
    tree["window-history/projection.ts"] = `
/** 本模块不许 writeFileSync( 也不许持有 CanonicalStreamWriter。 */
export const note = "writeFileSync( CanonicalStreamWriter";
// new CanonicalStreamWriter( 只是这行注释里的字
export const projection = 1;
`;
    expect(findingKinds(fixtureTree(tree))).toEqual([]);
  });

  it("reports the real src/ tree with the read-only port present and the single writer wired", () => {
    // 生产只读投影 + port 已落地在 src/window-history/（恰好一处 MistWindowHistoryPort，
    // 成员恰好 read/summarize，该目录不持有 writer、不落盘），且唯一
    // new CanonicalStreamWriter 已接在 src/window-host/window-history-host.ts —— 投影目录
    // 之外恰好一处。所以审计 findings 为空，WH-06 此刻真绿。
    const audit = auditWindowHistoryWriteSurface(join(repoRoot, "src"));
    expect(audit.portDeclarations).toHaveLength(1);
    expect(audit.portDeclarations[0]?.typeName).toBe("MistWindowHistoryPort");
    expect(audit.portDeclarations[0]?.members).toEqual(["read", "summarize"]);
    expect(audit.writerConstructionSites).toEqual(["window-host/window-history-host.ts"]);
    expect(audit.findings).toEqual([]);
  });
});

describe("#120 judging runner", () => {
  const driverPath = join(repoRoot, "src/window-history-acceptance-driver.ts");

  function runRunner(args: readonly string[]): { status: number | null; stdout: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "acceptance/window-history-run.ts"), ...args],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
  }

  it("lights all six lamps true-green now that the production driver has landed", () => {
    // 本 PR（FEAT-003）交生产驱动：src/window-history-acceptance-driver.ts 已存在并
    // 导出 createWindowHistoryDriver()，真起子进程、真落盘、真 SIGKILL，把 WH-01～WH-05
    // 用真实证据点绿；WH-06 早在唯一写方落地时静态真绿。所以判卷此刻真绿 6/6、无红无桩。
    expect(
      existsSync(driverPath),
      "FEAT-003 交生产驱动，src/window-history-acceptance-driver.ts 必须存在",
    ).toBe(true);

    const report = runRunner([]);
    expect(report.status, "报告模式必须退出 0").toBe(0);
    for (const id of expectedWindowHistoryCheckIds) {
      expect(report.stdout).toContain(`🟢 ${id}`);
    }
    expect(report.stdout).toContain(
      `真绿 ${expectedWindowHistoryCheckIds.length} / ${expectedWindowHistoryCheckIds.length}`,
    );
    expect(report.stdout).not.toContain("🔴");
    expect(report.stdout).not.toContain("🟡");

    const strict = runRunner(["--strict"]);
    expect(strict.status, "严格模式必须退出 0").toBe(0);
  });

  it("errors out on a broken driver instead of silently downgrading it", () => {
    // 判卷不允许「驱动存在但坏」伪装成缺驱动的红灯起点。用真实驱动的备份换上一个只导出
    // STUBBED、没有 createWindowHistoryDriver() 的坏驱动，断言 runner 直接抛错，然后原样
    // 还原真实驱动（本用例不得破坏 FEAT-003 交付的生产驱动）。
    expect(existsSync(driverPath)).toBe(true);
    const original = readFileSync(driverPath, "utf8");
    writeFileSync(driverPath, "export const STUBBED = [];\n");
    try {
      const result = runRunner([]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("没有导出 createWindowHistoryDriver()");
      expect(result.stdout).not.toContain("缺驱动");
    } finally {
      writeFileSync(driverPath, original);
    }
    expect(readFileSync(driverPath, "utf8")).toBe(original);
  });
});
