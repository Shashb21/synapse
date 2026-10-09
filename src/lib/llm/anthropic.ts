import { anthropicModel, hasAnthropicKey } from "@/lib/config";
import { fetchProvider, ProviderError, parseProviderErrorBody, redactSecrets } from "@/modules/llm/provider-error";

type AnthropicMessage = {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
};

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
  const target = { provider_id: "anthropic-claude", provider_name: "Anthropic", key_env: "ANTHROPIC_API_KEY" };
  const { res, text } = await fetchProvider("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: anthropicModel(),
      max_tokens: args.maxTokens ?? 8192,
      temperature: 0,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    }),
  }, target);
  if (!res.ok) {
    // Typed and classified like every provider call (KAN-68); the key is never in it.
    const parsed = parseProviderErrorBody(text);
    throw new ProviderError({
      ...target,
      status: res.status,
      error_type: parsed.error_type,
      provider_message: parsed.message
        ? redactSecrets(parsed.message, [process.env.ANTHROPIC_API_KEY ?? ""]).slice(0, 300)
        : null,
    });
  }
  const body = JSON.parse(text) as AnthropicMessage;
  const reply = (body.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return extractJsonObject(reply);
}
