export function hasLlamaCloudKey(): boolean {
  return Boolean(process.env.LLAMA_CLOUD_API_KEY?.trim());
}

export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function hasXaiKey(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

export function hasOpenAiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5";
}

export function llamaParseTier(): "cost_effective" | "agentic" | "agentic_plus" {
  const raw = process.env.LLAMA_PARSE_TIER?.trim();
  if (raw === "cost_effective" || raw === "agentic_plus" || raw === "agentic") {
    return raw;
  }
  return "agentic";
}

export function providerStatus() {
  const anyLlmKey = hasAnthropicKey() || hasXaiKey() || hasOpenAiKey();
  return {
    llama_cloud: hasLlamaCloudKey(),
    anthropic: hasAnthropicKey(),
    xai: hasXaiKey(),
    openai: hasOpenAiKey(),
    anthropic_model: hasAnthropicKey() ? anthropicModel() : null,
    llama_tier: hasLlamaCloudKey() ? llamaParseTier() : null,
    live_extractor: hasAnthropicKey() ? "claude" : anyLlmKey ? "api_key" : "local",
    live_parser: hasLlamaCloudKey() ? "llamaparse" : "local",
  };
}
