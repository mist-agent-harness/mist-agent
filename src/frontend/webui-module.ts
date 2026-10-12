import type { WebuiRuntime } from "../../acceptance/frontend-adapter-driver.ts";
/**
 * WebUI 插件事务模块：`prepare()` 注册一个 `connection` resource，其 `activate()` 经外部
 * appliance 启动服务、`dispose()` 停止。**activate 一旦开始尝试，resource 就负 stop/revoke
 * 责任**：即使 startService 抛错（外部已产生部分效果），dispose 仍会调用幂等 stopService 清理。
 *
 * token 只从 `context.env`（执行边界由 host 的 `resolveEnvironment` 交付）读取，不进 config。
 * moduleRef 由本模块源文件内容 digest 得到（见 webui-install.ts）。
 */
import type { PluginModuleV0, PreparedPlugin, ResourceDeclaration } from "../plugin/types.ts";

export const WEBUI_MODULE_SOURCE_LABEL = "mist.webui/open-webui-bridge/v1";

export interface WebuiServiceRequest {
  runtime: WebuiRuntime;
  serviceId: string;
  endpointId: string;
  /** Bearer 只在内存传递；不落 config/ledger/argv/URL。 */
  token: string;
}

export interface WebuiAppliancePort {
  /** 幂等：即使未曾成功返回，也要能安全地清理该 serviceId 的部分资源。 */
  startService(input: WebuiServiceRequest): Promise<{ url: string; runtimeUsed: WebuiRuntime }>;
  stopService(serviceId: string): Promise<void>;
}

export function createWebuiModule(options: {
  appliance: WebuiAppliancePort;
  runtime: WebuiRuntime;
  serviceId: string;
  started: { value: { url: string; runtimeUsed: WebuiRuntime } | null };
}): PluginModuleV0 {
  return {
    async prepare(context): Promise<PreparedPlugin> {
      const endpointId = context.env.MIST_WEBUI_ENDPOINT ?? "";
      const token = context.env.MIST_WEBUI_BEARER ?? "";
      // activate 尝试开始即置位；dispose 凭它清理，即便 start 未返回。
      let attempted = false;
      const declaration: ResourceDeclaration = {
        id: `webui-service-${options.serviceId}`,
        kind: "connection",
        recoveryKey: `webui-service-${options.serviceId}`,
        async activate() {
          attempted = true;
          options.started.value = await options.appliance.startService({
            runtime: options.runtime,
            serviceId: options.serviceId,
            endpointId,
            token,
          });
        },
        async dispose() {
          if (!attempted) return;
          // 先清重入位：一次 activate 只对应一次对外 stop 尝试（重试由既有恢复/manual action 承担）。
          attempted = false;
          options.started.value = null;
          await options.appliance.stopService(options.serviceId);
        },
      };
      const handle = context.register(declaration);
      return {
        async activate() {
          return {
            async dispose() {
              return { revoked: [], failed: [] };
            },
          };
        },
        async rollback() {
          await handle.revoke();
        },
      };
    },
  };
}
