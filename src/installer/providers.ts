import type { CredentialMethod } from "./contracts.ts";

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
 * Pi currently documents subscription OAuth for Claude and OpenAI Codex. xAI/Grok is
 * documented as API-key authentication, so the installer must not offer a dead OAuth path.
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
    methods: ["api-key"],
  },
] as const;

export function providerById(providerId: string): ProviderCapability {
  const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new Error(`unsupported provider: ${providerId}`);
  return provider;
}
