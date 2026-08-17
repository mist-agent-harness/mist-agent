import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  INSTALLER_DRAFT_SCHEMA_VERSION,
  type InstallCommitReceipt,
  type InstallerDraft,
  InstallerValidationError,
  type MistInstallConfigV0,
  assertSafeInstallerId,
  credentialSecretRef,
  validateReadyDraft,
} from "./contracts.ts";

interface CurrentPointer {
  schemaVersion: 1;
  snapshotId: string;
  sourceDraftId?: string;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateFile(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    rmSync(temporaryPath, { force: true, recursive: true });
    throw error;
  }
}

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * File-backed installer transaction store.
 *
 * Draft metadata and draft secrets are separate. Commit writes an immutable snapshot first,
 * then atomically switches current.json. A crash before the pointer switch leaves the previous
 * installation authoritative; a crash after it leaves a complete new snapshot authoritative.
 */
export class InstallerStateStore {
  readonly #rootDir: string;
  readonly #draftPath: string;
  readonly #draftSecretsDir: string;
  readonly #snapshotsDir: string;
  readonly #currentPath: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
    this.#draftPath = join(rootDir, "installer-draft.json");
    this.#draftSecretsDir = join(rootDir, "draft-secrets");
    this.#snapshotsDir = join(rootDir, "snapshots");
    this.#currentPath = join(rootDir, "current.json");
    mkdirSync(this.#rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.#snapshotsDir, { recursive: true, mode: 0o700 });
  }

  loadDraft(): InstallerDraft | null {
    try {
      const draft = parseJson<InstallerDraft>(this.#draftPath);
      if (
        draft.schemaVersion !== INSTALLER_DRAFT_SCHEMA_VERSION ||
        typeof draft.draftId !== "string" ||
        !Array.isArray(draft.credentials)
      ) {
        throw new InstallerValidationError("installer draft has an unsupported shape");
      }
      assertSafeInstallerId(draft.draftId, "draft id");
      if (!Array.isArray(draft.sideEffects)) draft.sideEffects = [];
      for (const sideEffect of draft.sideEffects) {
        if (
          sideEffect.kind !== "memory_dir_created" ||
          typeof sideEffect.path !== "string" ||
          sideEffect.path.trim().length === 0 ||
          sideEffect.ownerDraftId !== draft.draftId
        ) {
          throw new InstallerValidationError("installer draft has an invalid side-effect receipt");
        }
      }
      const pointer = this.#loadCurrentPointer();
      if (pointer?.sourceDraftId === draft.draftId) {
        try {
          this.discardDraft(draft.draftId);
        } catch {
          // The current pointer proves this draft committed. Never expose it as resumable.
        }
        return null;
      }
      return draft;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  saveDraft(draft: InstallerDraft): void {
    writePrivateFile(this.#draftPath, JSON.stringify(draft, null, 2));
  }

  stageSecret(draftId: string, secretRef: string, secret: string): void {
    assertSafeInstallerId(draftId, "draft id");
    assertSafeInstallerId(secretRef, "credential secretRef");
    if (secret.length === 0) {
      throw new InstallerValidationError("credential secret must not be empty");
    }
    const draftSecrets = join(this.#draftSecretsDir, draftId);
    mkdirSync(draftSecrets, { recursive: true, mode: 0o700 });
    writePrivateFile(join(draftSecrets, secretRef), secret);
  }

  hasStagedSecret(draftId: string, secretRef: string): boolean {
    assertSafeInstallerId(draftId, "draft id");
    assertSafeInstallerId(secretRef, "credential secretRef");
    try {
      readFileSync(join(this.#draftSecretsDir, draftId, secretRef));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  discardDraft(expectedDraftId: string): void {
    assertSafeInstallerId(expectedDraftId, "draft id");
    try {
      const stored = parseJson<InstallerDraft>(this.#draftPath);
      if (stored.draftId !== expectedDraftId) {
        throw new InstallerValidationError(
          `refusing to discard draft ${stored.draftId}; expected ${expectedDraftId}`,
        );
      }
      rmSync(this.#draftPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    rmSync(join(this.#draftSecretsDir, expectedDraftId), { recursive: true, force: true });
  }

  commit(draft: InstallerDraft): InstallCommitReceipt {
    const config = validateReadyDraft(draft);
    for (const credential of draft.credentials) {
      const secretRef = credentialSecretRef(credential.ref);
      if (!this.hasStagedSecret(draft.draftId, secretRef)) {
        throw new InstallerValidationError(
          `credential ${credential.ref.id} has no staged secret material`,
        );
      }
    }

    const snapshotId = `install-${randomUUID()}`;
    const temporarySnapshot = join(this.#snapshotsDir, `.${snapshotId}.tmp`);
    const finalSnapshot = join(this.#snapshotsDir, snapshotId);
    const credentialsDirectory = join(temporarySnapshot, "credentials");
    mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
    try {
      writePrivateFile(join(temporarySnapshot, "config.json"), JSON.stringify(config, null, 2));
      for (const credential of draft.credentials) {
        const secretRef = credentialSecretRef(credential.ref);
        const secret = readFileSync(join(this.#draftSecretsDir, draft.draftId, secretRef), "utf8");
        writePrivateFile(join(credentialsDirectory, secretRef), secret);
      }
      renameSync(temporarySnapshot, finalSnapshot);
      fsyncDirectory(this.#snapshotsDir);
      const pointer: CurrentPointer = {
        schemaVersion: 1,
        snapshotId,
        sourceDraftId: draft.draftId,
      };
      writePrivateFile(this.#currentPath, JSON.stringify(pointer));
    } catch (error) {
      rmSync(temporarySnapshot, { recursive: true, force: true });
      throw error;
    }

    // The new snapshot is already authoritative. Cleanup must never turn a successful commit
    // into a reported failure, because callers might retry and create a second installation.
    try {
      this.discardDraft(draft.draftId);
    } catch {
      // loadDraft reconciles sourceDraftId against current.json and never resumes this stale draft.
    }
    return { snapshotId, config };
  }

  loadCurrentConfig(): MistInstallConfigV0 | null {
    try {
      const pointer = this.#loadCurrentPointer();
      if (pointer === null) return null;
      assertSafeInstallerId(pointer.snapshotId, "snapshot id");
      return parseJson<MistInstallConfigV0>(
        join(this.#snapshotsDir, pointer.snapshotId, "config.json"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  readCredentialSecret(credentialId: string): string {
    const secretRef = credentialSecretRef({ id: credentialId });
    const pointer = parseJson<CurrentPointer>(this.#currentPath);
    return readFileSync(
      join(this.#snapshotsDir, pointer.snapshotId, "credentials", secretRef),
      "utf8",
    );
  }

  #loadCurrentPointer(): CurrentPointer | null {
    try {
      const pointer = parseJson<CurrentPointer>(this.#currentPath);
      if (pointer.schemaVersion !== 1) {
        throw new InstallerValidationError(
          `unsupported current pointer schemaVersion: ${pointer.schemaVersion}`,
        );
      }
      if (pointer.sourceDraftId !== undefined) {
        assertSafeInstallerId(pointer.sourceDraftId, "source draft id");
      }
      return pointer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
