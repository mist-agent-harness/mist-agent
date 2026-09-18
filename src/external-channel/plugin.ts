import type {
  ActivePlugin,
  DisposeReport,
  PluginModuleV0,
  RecoveredPlugin,
} from "../plugin/types.ts";
import type { ExternalChannelHost } from "./host.ts";

export interface ExternalChannelPluginOptions {
  readonly connectionId: string;
}

/** Registers the resident channel through the existing Plugin Protocol v0 connection lifecycle. */
export function createExternalChannelPlugin<TContext>(
  channel: ExternalChannelHost<TContext>,
  options: ExternalChannelPluginOptions,
): PluginModuleV0 {
  if (options.connectionId.trim().length === 0) {
    throw new Error("external channel connectionId must be non-empty");
  }
  const recoveryKey = `external-channel:${options.connectionId}`;
  return {
    async prepare(context) {
      context.register({
        id: options.connectionId,
        kind: "connection",
        recoveryKey,
        async activate() {
          channel.activate();
        },
        async dispose() {
          channel.deactivate();
        },
      });
      return {
        async activate(): Promise<ActivePlugin> {
          return {
            async dispose(): Promise<DisposeReport> {
              return { revoked: [], failed: [] };
            },
          };
        },
        async rollback() {
          channel.deactivate();
        },
      };
    },
    async recover(): Promise<RecoveredPlugin> {
      return {
        async revoke(resource) {
          if (resource.recoveryKey !== recoveryKey) {
            throw new Error(`external channel cannot recover ${resource.id}`);
          }
          channel.deactivate();
        },
        async rollback() {
          channel.deactivate();
        },
        async dispose(): Promise<DisposeReport> {
          channel.deactivate();
          return { revoked: [options.connectionId], failed: [] };
        },
      };
    },
  };
}
