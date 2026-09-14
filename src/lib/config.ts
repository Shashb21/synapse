export function hasLlamaCloudKey(): boolean {
  return Boolean(process.env.LLAMA_CLOUD_API_KEY?.trim());
}

export function hasAnthropicKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
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
  return {
    llama_cloud: hasLlamaCloudKey(),
    anthropic: hasAnthropicKey(),
    anthropic_model: hasAnthropicKey() ? anthropicModel() : null,
    llama_tier: hasLlamaCloudKey() ? llamaParseTier() : null,
    live_extractor: hasAnthropicKey() ? "claude" : "local",
    live_parser: hasLlamaCloudKey() ? "llamaparse" : "local",
  };
}
