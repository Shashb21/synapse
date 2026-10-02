import { anthropicModel, hasAnthropicKey } from "@/lib/config";
import { anthropicAcceptsTemperature, anthropicText } from "@/modules/llm/provider";

type AnthropicMessage = Record<string, unknown> & { error?: { message?: string } };

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
  const body = (await res.json()) as AnthropicMessage;
  if (!res.ok) {
    throw new Error(body.error?.message ?? `Anthropic HTTP ${res.status}`);
  }
  return extractJsonObject(anthropicText(body));
}
