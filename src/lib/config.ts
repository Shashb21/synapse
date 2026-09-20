import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ANTHROPIC_KEY_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_KEY", "CLAUDE_API_KEY"] as const;

function readDotenvValue(file: string, names: readonly string[]): string | undefined {
  try {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, "utf8");
    for (const name of names) {
      const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
      const raw = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
      if (raw) return raw;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Canonical Anthropic key. Accepts aliases already used in this environment and gitignored `.env.local`. */
export function anthropicApiKey(): string | undefined {
  for (const name of ANTHROPIC_KEY_NAMES) {
    const value = process.env[name]?.trim();
    if (value) {
      if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = value;
      return value;
    }
  }
  const fromFile =
    process.env.VITEST
      ? undefined
      : (readDotenvValue(".env.local", ANTHROPIC_KEY_NAMES) ??
        readDotenvValue(".env", ANTHROPIC_KEY_NAMES));
  if (fromFile) {
    process.env.ANTHROPIC_API_KEY = fromFile;
    return fromFile;
  }
  return undefined;
}

export function hasLlamaCloudKey(): boolean {
  return Boolean(process.env.LLAMA_CLOUD_API_KEY?.trim());
}

export function hasAnthropicKey(): boolean {
  return Boolean(anthropicApiKey());
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
