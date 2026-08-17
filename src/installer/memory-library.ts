import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MARKER_NAME = ".mist-memory.json";
const MARKER_BODY = JSON.stringify({ schemaVersion: 1, kind: "mist-empty-library" });

export interface MemoryLibraryPort {
  assertExisting(path: string): void;
  createEmpty(path: string): void;
  discardEmpty(path: string): boolean;
}

/** Creates a complete empty library by sibling-directory rename and only removes its own marker. */
export class FileMemoryLibrary implements MemoryLibraryPort {
  assertExisting(path: string): void {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`memory library does not exist or is not a directory: ${path}`);
    }
  }

  createEmpty(path: string): void {
    if (existsSync(path)) {
      const markerPath = join(path, MARKER_NAME);
      if (existsSync(markerPath) && readFileSync(markerPath, "utf8") === MARKER_BODY) return;
      throw new Error(`memory library path already exists: ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.mist-tmp-${randomUUID()}`;
    try {
      mkdirSync(temporaryPath, { mode: 0o700 });
      writeFileSync(join(temporaryPath, MARKER_NAME), MARKER_BODY, { mode: 0o600 });
      renameSync(temporaryPath, path);
    } catch (error) {
      rmSync(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  }

  discardEmpty(path: string): boolean {
    if (!existsSync(path)) return true;
    const entries = readdirSync(path);
    const markerPath = join(path, MARKER_NAME);
    if (
      entries.length !== 1 ||
      entries[0] !== MARKER_NAME ||
      !existsSync(markerPath) ||
      readFileSync(markerPath, "utf8") !== MARKER_BODY
    ) {
      return false;
    }
    rmSync(path, { recursive: true });
    return true;
  }
}
