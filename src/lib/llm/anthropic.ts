import { anthropicModel, hasAnthropicKey } from "@/lib/config";
import { anthropicAcceptsTemperature, anthropicText } from "@/modules/llm/provider";
import { ProviderError, parseProviderErrorBody, redactSecrets } from "@/modules/llm/provider-error";

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Claude did not return a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function completeJson(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<unknown> {
  if (!hasAnthropicKey()) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: args.maxTokens ?? 8192,
      // Claude 5 models reject sampling parameters (KAN-65).
      ...(anthropicAcceptsTemperature(anthropicModel()) ? { temperature: 0 } : {}),
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Typed and classified like every provider call (KAN-68); the key is never in it.
    const parsed = parseProviderErrorBody(text);
    throw new ProviderError({
      provider_id: "anthropic-claude",
      provider_name: "Anthropic",
      key_env: "ANTHROPIC_API_KEY",
      status: res.status,
      error_type: parsed.error_type,
      provider_message: parsed.message
        ? redactSecrets(parsed.message, [process.env.ANTHROPIC_API_KEY ?? ""]).slice(0, 300)
        : null,
    });
  }
  return extractJsonObject(anthropicText(JSON.parse(text) as Record<string, unknown>));
}
