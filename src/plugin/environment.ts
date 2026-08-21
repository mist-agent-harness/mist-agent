/**
 * env 交付装配（RFC §2 #62：env 值只经 `PluginPrepareContext.env` 交付）。
 *
 * 职责：把「已校验 manifest + 已定型 instance config」装配成交给 prepare 的只读 env 映射——
 * 键集合**恰好**是已声明且已绑定的 name：未声明的名字不出现、声明未绑定的可选项不出现、
 * `secretRef` 在此执行边界经宿主解析器换成值（值只进内存 绝不落任何持久面）。
 * `required` 缺绑定在 validateBindings 已拦（REQUIREMENT_MISSING）；本层再拦一道以防
 * 调用方跳过就绪门（fail-closed 不信上游）。
 */

import { type BindingValidation, type PluginManifestV0, validateBindings } from "./manifest.ts";

export type SecretResolver = (secretRef: string) => string;

export type EnvironmentAssembly =
  | { readonly ok: true; readonly env: Readonly<Record<string, string>> }
  | Extract<BindingValidation, { ok: false }>;

/**
 * 装配交付集。config 收 unknown（与 validateBindings 同门）；任何绑定形状/完备性问题
 * 原样透传其 reasonCode。解析器抛错按 CONFIG_INVALID fail-closed（secret 引用坏了
 * 不能装成「没这个变量」）。
 */
export function resolveEnvironment(
  manifest: PluginManifestV0,
  config: unknown,
  resolveSecret: SecretResolver,
): EnvironmentAssembly {
  const validated = validateBindings(manifest, config);
  if (!validated.ok) {
    return validated;
  }
  const bindings = (
    config as { environment: readonly { name: string; value?: string; secretRef?: string }[] }
  ).environment;
  const declaredSecret = new Map(manifest.env.map((e) => [e.name, e.secret]));
  const env: Record<string, string> = {};
  for (const binding of bindings) {
    if (declaredSecret.get(binding.name) === true) {
      const ref = binding.secretRef as string;
      let value: string;
      try {
        value = resolveSecret(ref);
      } catch {
        return {
          ok: false,
          reasonCode: "CONFIG_INVALID",
          detail: `env ${binding.name}: secretRef could not be resolved at the execution boundary`,
        };
      }
      env[binding.name] = value;
    } else {
      env[binding.name] = binding.value as string;
    }
  }
  return { ok: true, env: Object.freeze(env) };
}
