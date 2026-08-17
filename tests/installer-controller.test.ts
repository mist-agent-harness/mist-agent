import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRef, InstallerDraft } from "../src/installer/contracts.ts";
import { InstallerController } from "../src/installer/controller.ts";
import { InstallerStateStore } from "../src/installer/state-store.ts";

const temporaryDirectories: string[] = [];

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-installer-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function apiCredential(id = "codex-main"): CredentialRef {
  return {
    id,
    label: "Codex main",
    providerId: "codex",
    method: "api-key",
    secretRef: `${id}.token`,
    status: "incomplete",
  };
}

function completeDraft(controller: InstallerController): InstallerDraft {
  controller.start("resident-1");
  controller.saveCredentials([{ ref: apiCredential(), secret: "secret-value" }]);
  controller.saveBindings([
    {
      residentId: "resident-1",
      purpose: "main",
      adapterId: "pi",
      credentialId: "codex-main",
    },
  ]);
  controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
  return controller.saveMemory({ kind: "create", path: "/tmp/mist-memory" });
}

describe("installer controller", () => {
  it("persists progress after every step and resumes at the exact next screen", () => {
    const directory = freshDirectory();
    const first = new InstallerController(new InstallerStateStore(directory));
    first.start("resident-1");
    first.saveCredentials([{ ref: apiCredential(), secret: "secret-value" }]);
    first.saveBindings([
      {
        residentId: "resident-1",
        purpose: "main",
        adapterId: "pi",
        credentialId: "codex-main",
      },
    ]);

    const resumed = new InstallerController(new InstallerStateStore(directory));
    const draft = resumed.start("resident-1", "resume");
    expect(draft.progress.currentStep).toBe("frontend");
    expect(draft.progress.completedSteps).toEqual(["credentials", "bindings"]);
    expect(draft.credentialRefs[0]?.status).toBe("ready");
  });

  it("discard removes both the visible draft and staged credential material", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ ref: apiCredential(), secret: "secret-value" }]);
    controller.discard();

    const store = new InstallerStateStore(directory);
    expect(store.loadDraft()).toBeNull();
    expect(store.hasStagedSecret("codex-main.token")).toBe(false);
  });

  it("commits a complete snapshot without putting secret text in config or draft", () => {
    const directory = freshDirectory();
    const store = new InstallerStateStore(directory);
    const controller = new InstallerController(store);
    completeDraft(controller);
    const receipt = controller.commit();

    expect(store.loadDraft()).toBeNull();
    expect(store.loadCurrentConfig()).toEqual(receipt.config);
    expect(store.readCredentialSecret("codex-main.token")).toBe("secret-value");
    expect(JSON.stringify(receipt.config)).not.toContain("secret-value");
    expect(readFileSync(join(directory, "current.json"), "utf8")).not.toContain("secret-value");
  });

  it("writes draft, config, pointer, and credential files with owner-only permissions", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    completeDraft(controller);
    expect(statSync(join(directory, "installer-draft.json")).mode & 0o777).toBe(0o600);
    const receipt = controller.commit();
    expect(statSync(join(directory, "current.json")).mode & 0o777).toBe(0o600);
    expect(
      statSync(join(directory, "snapshots", receipt.snapshotId, "config.json")).mode & 0o777,
    ).toBe(0o600);
    expect(
      statSync(join(directory, "snapshots", receipt.snapshotId, "credentials", "codex-main.token"))
        .mode & 0o777,
    ).toBe(0o600);
  });

  it("refuses adapter bindings that violate a credential constraint", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([
      {
        ref: {
          ...apiCredential("claude-login"),
          providerId: "claude",
          method: "oauth",
          adapterConstraint: "claude-agent-sdk",
        },
        secret: "oauth-material",
      },
    ]);
    controller.saveBindings([
      {
        residentId: "resident-1",
        purpose: "main",
        adapterId: "pi",
        credentialId: "claude-login",
      },
    ]);
    controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
    controller.saveMemory({ kind: "existing", path: "/tmp/existing" });

    expect(() => controller.commit()).toThrow(/requires adapter claude-agent-sdk/);
  });

  it("rejects a second binding for the same resident and purpose", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ ref: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([
      {
        residentId: "resident-1",
        purpose: "main",
        adapterId: "pi",
        credentialId: "codex-main",
      },
      {
        residentId: "resident-1",
        purpose: "main",
        adapterId: "other",
        credentialId: "codex-main",
      },
    ]);
    controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
    controller.saveMemory({ kind: "existing", path: "/tmp/existing" });

    expect(() => controller.commit()).toThrow(/duplicate main binding/);
  });

  it("returns the same receipt when commit is retried in the same controller", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    completeDraft(controller);

    const first = controller.commit();
    const second = controller.commit();

    expect(second).toEqual(first);
  });

  it("refuses to activate the official-skin stub before its dependencies land", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ ref: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([
      {
        residentId: "resident-1",
        purpose: "main",
        adapterId: "pi",
        credentialId: "codex-main",
      },
    ]);
    controller.saveFrontend({
      kind: "official-skin",
      pluginId: "mist-official-skin",
      installation: "pending",
    });
    controller.saveMemory({ kind: "create", path: "/tmp/mist-memory" });

    expect(() => controller.commit()).toThrow(/cannot be activated yet/);
  });
});
