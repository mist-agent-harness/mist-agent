import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  InstallerCredential,
  InstallerDraft,
  LaneBinding,
} from "../src/installer/contracts.ts";
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

function apiCredential(id = "codex-main"): InstallerCredential {
  return {
    ref: { id, type: "api_key", issuerId: "mist-installer-api-key" },
    label: "Codex main",
    providerId: "codex",
    status: "incomplete",
  };
}

function primaryBinding(id = "codex-main"): LaneBinding {
  return {
    residentId: "resident-1",
    lane: "primary",
    adapterId: "pi",
    credentialRef: { id, type: "api_key", issuerId: "mist-installer-api-key" },
  };
}

function completeDraft(controller: InstallerController): InstallerDraft {
  controller.start("resident-1");
  controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
  controller.saveBindings([primaryBinding()]);
  controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
  return controller.saveMemory({ kind: "create", path: "/tmp/mist-memory" });
}

describe("installer controller", () => {
  it("persists progress after every step and resumes at the exact next screen", () => {
    const directory = freshDirectory();
    const first = new InstallerController(new InstallerStateStore(directory));
    first.start("resident-1");
    first.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    first.saveBindings([primaryBinding()]);

    const resumed = new InstallerController(new InstallerStateStore(directory));
    const draft = resumed.start("resident-1", "resume");
    expect(draft.progress.currentStep).toBe("frontend");
    expect(draft.progress.completedSteps).toEqual(["credentials", "bindings"]);
    expect(draft.credentials[0]?.status).toBe("ready");
  });

  it("returns to credentials without discarding saved credentials when a lane cannot be bound", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([primaryBinding()]);

    const draft = controller.revisitCredentials();

    expect(draft.progress.currentStep).toBe("credentials");
    expect(draft.progress.completedSteps).toEqual([]);
    expect(draft.credentials).toHaveLength(1);
    expect(draft.credentials[0]?.ref.id).toBe("codex-main");
    expect(draft.bindings).toEqual([]);
  });

  it("returns a pending review to frontend while preserving completed memory", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([primaryBinding()]);
    controller.saveFrontend({
      kind: "official-skin",
      pluginId: "mist-official-skin",
      installation: "pending",
    });
    controller.saveMemory({ kind: "create", path: "/tmp/mist-memory" });

    const revisited = controller.revisitFrontend();
    expect(revisited.progress.currentStep).toBe("frontend");
    expect(revisited.memory).toEqual({ kind: "create", path: "/tmp/mist-memory" });

    const changed = controller.saveFrontend({
      kind: "external",
      integration: "mist-session-api",
    });
    expect(changed.progress.currentStep).toBe("review");
    expect(changed.memory).toEqual(revisited.memory);
  });

  it("discard removes both the visible draft and staged credential material", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    controller.discard();

    const store = new InstallerStateStore(directory);
    expect(store.loadDraft()).toBeNull();
    expect(store.hasStagedSecret("codex-main.credential")).toBe(false);
  });

  it("commits a complete snapshot without putting secret text in config or draft", () => {
    const directory = freshDirectory();
    const store = new InstallerStateStore(directory);
    const controller = new InstallerController(store);
    completeDraft(controller);
    const receipt = controller.commit();

    expect(store.loadDraft()).toBeNull();
    expect(store.loadCurrentConfig()).toEqual(receipt.config);
    expect(store.readCredentialSecret("codex-main")).toBe("secret-value");
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
      statSync(
        join(directory, "snapshots", receipt.snapshotId, "credentials", "codex-main.credential"),
      ).mode & 0o777,
    ).toBe(0o600);
  });

  it("refuses adapter bindings that violate a credential constraint", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([
      {
        credential: {
          ...apiCredential("claude-login"),
          ref: { id: "claude-login", type: "claude_oauth", issuerId: "pi" },
          providerId: "claude",
        },
        secret: "oauth-material",
      },
    ]);
    controller.saveBindings([
      {
        residentId: "resident-1",
        lane: "primary",
        adapterId: "pi",
        credentialRef: { id: "claude-login", type: "claude_oauth", issuerId: "pi" },
      },
    ]);
    controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
    controller.saveMemory({ kind: "existing", path: "/tmp/existing" });

    expect(() => controller.commit()).toThrow(/requires adapter claude-agent-sdk/);
  });

  it("refuses a binding whose issuer does not match the stored credential ref", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([
      {
        ...primaryBinding(),
        credentialRef: {
          id: "codex-main",
          type: "api_key",
          issuerId: "unregistered-issuer",
        },
      },
    ]);
    controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
    controller.saveMemory({ kind: "existing", path: "/tmp/existing" });

    expect(() => controller.commit()).toThrow(/type or issuer does not match/);
  });

  it("refuses a credential ref that cannot name an active issuer", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    const credential = apiCredential();
    credential.ref.issuerId = "unregistered-issuer";
    controller.start("resident-1");
    controller.saveCredentials([{ credential, secret: "secret-value" }]);
    controller.saveBindings([
      {
        ...primaryBinding(),
        credentialRef: { ...credential.ref },
      },
    ]);
    controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
    controller.saveMemory({ kind: "existing", path: "/tmp/existing" });

    expect(() => controller.commit()).toThrow(/issuer is unavailable/);
  });

  it("rejects a second binding for the same resident and lane", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([
      {
        residentId: "resident-1",
        lane: "primary",
        adapterId: "pi",
        credentialRef: {
          id: "codex-main",
          type: "api_key",
          issuerId: "mist-installer-api-key",
        },
      },
      {
        residentId: "resident-1",
        lane: "primary",
        adapterId: "other",
        credentialRef: {
          id: "codex-main",
          type: "api_key",
          issuerId: "mist-installer-api-key",
        },
      },
    ]);
    controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
    controller.saveMemory({ kind: "existing", path: "/tmp/existing" });

    expect(() => controller.commit()).toThrow(/duplicate primary binding/);
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
    controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([primaryBinding()]);
    controller.saveFrontend({
      kind: "official-skin",
      pluginId: "mist-official-skin",
      installation: "pending",
    });
    controller.saveMemory({ kind: "create", path: "/tmp/mist-memory" });

    expect(() => controller.commit()).toThrow(/cannot be activated yet/);
  });

  it("validates a Claude-compatible gateway using an API key reference", () => {
    const directory = freshDirectory();
    const controller = new InstallerController(new InstallerStateStore(directory));
    controller.start("resident-1");
    controller.saveCredentials([{ credential: apiCredential(), secret: "secret-value" }]);
    controller.saveBindings([
      primaryBinding(),
      {
        residentId: "resident-1",
        lane: "coding",
        adapterId: "claude-agent-sdk",
        credentialRef: {
          id: "codex-main",
          type: "api_key",
          issuerId: "mist-installer-api-key",
        },
        adapterConfig: {
          baseUrl: "https://gateway.example.test",
          tokenCredentialRef: {
            id: "codex-main",
            type: "api_key",
            issuerId: "mist-installer-api-key",
          },
        },
      },
    ]);
    controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
    controller.saveMemory({ kind: "existing", path: "/tmp/existing" });

    expect(() => controller.commit()).not.toThrow();
  });
});
