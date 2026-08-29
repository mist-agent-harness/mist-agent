import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface TreeEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  sha256: string;
  size: number;
}

export interface TreeSnapshot {
  digest: string;
  entries: TreeEntry[];
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isDescendantPath(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return pathFromParent !== "" && !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..";
}

export async function assertRealDescendant(parent: string, child: string): Promise<void> {
  const [realParent, realChild] = await Promise.all([realpath(parent), realpath(child)]);
  if (!isDescendantPath(realParent, realChild)) {
    throw new Error(`Unsafe path outside runner root: ${realChild}`);
  }
}

async function visit(root: string, current: string, entries: TreeEntry[]): Promise<void> {
  const names = await readdir(current);
  names.sort();
  for (const name of names) {
    const absolute = resolve(current, name);
    const stat = await lstat(absolute);
    const localPath = relative(root, absolute).split(sep).join("/");
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink is forbidden in evaluation sandboxes: ${localPath}`);
    }
    if (stat.isDirectory()) {
      entries.push({
        path: localPath,
        type: "directory",
        mode: stat.mode & 0o777,
        sha256: sha256(""),
        size: 0,
      });
      await visit(root, absolute, entries);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported filesystem entry in evaluation sandbox: ${localPath}`);
    }
    const bytes = await readFile(absolute);
    entries.push({
      path: localPath,
      type: "file",
      mode: stat.mode & 0o777,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
}

export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  if (!isAbsolute(root)) {
    throw new Error(`snapshotTree requires an absolute root: ${root}`);
  }
  const entries: TreeEntry[] = [];
  await visit(root, root, entries);
  const canonical = entries.map((entry) => JSON.stringify(entry)).join("\n");
  return { digest: sha256(canonical), entries };
}

export function changedPaths(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  return [...paths]
    .filter((path) => {
      const left = beforeByPath.get(path);
      const right = afterByPath.get(path);
      return JSON.stringify(left) !== JSON.stringify(right);
    })
    .sort();
}

export function pathMatchesOwnedPath(path: string, ownedPath: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedOwned = ownedPath.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalizedPath === normalizedOwned || normalizedPath.startsWith(`${normalizedOwned}/`);
}
