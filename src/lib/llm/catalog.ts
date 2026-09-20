import type { AgenticPurpose } from "@/lib/llm/agentic/types";

export const LLM_PROVIDERS = ["claude_code", "grok", "openrouter"] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export const LLM_MODULES = ["gaps", "hillclimb", "insight", "validate", "default"] as const;
export type LlmModuleId = (typeof LLM_MODULES)[number];

export type LlmRoute = {
  provider: LlmProviderId;
  model: string;
};

export type LlmCostRate = {
  input_per_mtok: number;
  output_per_mtok: number;
  currency: "USD";
};

export type LlmSettings = {
  routes: Record<LlmModuleId, LlmRoute>;
  costs: Record<string, LlmCostRate>;
  provider_defaults: Record<LlmProviderId, { model: string; base_url?: string }>;
};

export const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  claude_code: "Claude Code",
  grok: "Grok (xAI)",
  openrouter: "OpenRouter",
};

export const MODULE_LABELS: Record<LlmModuleId, string> = {
  gaps: "Gaps extract (proposer / critic / judge)",
  hillclimb: "Hill-climb / improver",
  insight: "Insight extract",
  validate: "Dashboard test ping",
  default: "Default / generic API",
};

export const DEFAULT_MODELS: Record<LlmProviderId, string> = {
  claude_code: "claude-sonnet-4-5",
  grok: "grok-4",
  openrouter: "anthropic/claude-sonnet-4.5",
};

export const DEFAULT_COSTS: Record<string, LlmCostRate> = {
  "claude-sonnet-4-5": { input_per_mtok: 3, output_per_mtok: 15, currency: "USD" },
  "grok-4": { input_per_mtok: 3, output_per_mtok: 15, currency: "USD" },
  "anthropic/claude-sonnet-4.5": { input_per_mtok: 3, output_per_mtok: 15, currency: "USD" },
  "openai/gpt-4o": { input_per_mtok: 2.5, output_per_mtok: 10, currency: "USD" },
};

export function defaultLlmSettings(): LlmSettings {
  return {
    routes: {
      gaps: { provider: "claude_code", model: DEFAULT_MODELS.claude_code },
      hillclimb: { provider: "claude_code", model: DEFAULT_MODELS.claude_code },
      insight: { provider: "claude_code", model: DEFAULT_MODELS.claude_code },
      validate: { provider: "claude_code", model: DEFAULT_MODELS.claude_code },
      default: { provider: "claude_code", model: DEFAULT_MODELS.claude_code },
    },
    costs: { ...DEFAULT_COSTS },
    provider_defaults: {
      claude_code: { model: DEFAULT_MODELS.claude_code },
      grok: { model: DEFAULT_MODELS.grok, base_url: "https://api.x.ai/v1" },
      openrouter: { model: DEFAULT_MODELS.openrouter, base_url: "https://openrouter.ai/api/v1" },
    },
  };
}

export function moduleForPurpose(purpose?: AgenticPurpose, explicit?: LlmModuleId): LlmModuleId {
  if (explicit && LLM_MODULES.includes(explicit)) return explicit;
  if (purpose === "proposer" || purpose === "critic" || purpose === "judge") return "gaps";
  if (purpose === "improver") return "hillclimb";
  if (purpose === "insight_extract") return "insight";
  if (purpose === "validate") return "validate";
  return "default";
}

export function estimateCostUsd(
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  costs: Record<string, LlmCostRate>,
): number | undefined {
  const rate = costs[model];
  if (!rate) return undefined;
  const input = ((inputTokens ?? 0) / 1_000_000) * rate.input_per_mtok;
  const output = ((outputTokens ?? 0) / 1_000_000) * rate.output_per_mtok;
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}

export function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value);
}

export function isLlmModuleId(value: unknown): value is LlmModuleId {
  return typeof value === "string" && (LLM_MODULES as readonly string[]).includes(value);
}

export function providerLoginHint(provider: LlmProviderId, moduleId?: LlmModuleId): string {
  const where = moduleId ? ` for the ${moduleId} module` : "";
  if (provider === "claude_code") {
    return `Claude Code is not connected${where}. Log in on Observe, run \`claude /login\`, or set CLAUDE_CODE_OAUTH_TOKEN. API keys are not used.`;
  }
  if (provider === "grok") {
    return `Grok is not connected${where}. Log in on Observe (device OAuth or paste token) or set GROK_OAUTH_TOKEN.`;
  }
  return `OpenRouter is not connected${where}. Log in on Observe (PKCE or paste key) or set OPENROUTER_OAUTH_TOKEN / OPENROUTER_API_KEY.`;
}
