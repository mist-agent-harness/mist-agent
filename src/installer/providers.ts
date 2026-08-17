import type { CredentialMethod, CredentialType } from "./contracts.ts";

export interface ProviderCapability {
  id: "claude" | "codex" | "grok";
  label: string;
  piAuthKey: string;
  methods: readonly [CredentialMethod, ...CredentialMethod[]];
  oauthAdapterConstraint?: "claude-agent-sdk";
}

/**
 * Upstream capability table, not a wish list.
 *
 * Pi currently documents subscription OAuth and API-key paths for Claude, OpenAI Codex,
 * and xAI/Grok. This table is the installer's active acquisition catalog.
 */
export const PROVIDERS: readonly ProviderCapability[] = [
  {
    id: "claude",
    label: "Claude",
    piAuthKey: "anthropic",
    methods: ["oauth", "api-key"],
    oauthAdapterConstraint: "claude-agent-sdk",
  },
  {
    id: "codex",
    label: "Codex",
    piAuthKey: "openai-codex",
    methods: ["oauth", "api-key"],
  },
  {
    id: "grok",
    label: "Grok / xAI",
    piAuthKey: "xai",
    methods: ["oauth", "api-key"],
  },
] as const;

export function providerById(providerId: string): ProviderCapability {
  const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new Error(`unsupported provider: ${providerId}`);
  return provider;
}

export function credentialTypeFor(
  provider: ProviderCapability,
  method: CredentialMethod,
): CredentialType {
  if (method === "api-key") return "api_key";
  switch (provider.id) {
    case "claude":
      return "claude_oauth";
    case "codex":
      return "codex_oauth";
    case "grok":
      return "grok_oauth";
  }
}

export function credentialIssuerIdFor(method: CredentialMethod): string {
  return method === "oauth" ? "pi" : "mist-installer-api-key";
}
