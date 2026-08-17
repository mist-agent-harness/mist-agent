import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMemoryLibrary } from "../src/installer/memory-library.ts";

const temporaryDirectories: string[] = [];

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-memory-library-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("file memory library", () => {
  it("creates a resumable empty library and safely removes it when discarded", () => {
    const root = freshDirectory();
    const path = join(root, "memory");
    const libraries = new FileMemoryLibrary();

    libraries.createEmpty(path);
    libraries.createEmpty(path);
    expect(existsSync(join(path, ".mist-memory.json"))).toBe(true);
    expect(libraries.discardEmpty(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("does not remove a library after a user adds content", () => {
    const root = freshDirectory();
    const path = join(root, "memory");
    const libraries = new FileMemoryLibrary();
    libraries.createEmpty(path);
    writeFileSync(join(path, "note.md"), "kept");

    expect(libraries.discardEmpty(path)).toBe(false);
    expect(existsSync(join(path, "note.md"))).toBe(true);
  });

  it("validates existing paths without claiming or modifying them", () => {
    const root = freshDirectory();
    const path = join(root, "existing");
    mkdirSync(path);
    const libraries = new FileMemoryLibrary();

    expect(() => libraries.assertExisting(path)).not.toThrow();
    expect(() => libraries.assertExisting(join(root, "missing"))).toThrow(/does not exist/);
  });
});
