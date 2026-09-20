import { extractJsonObject } from "@/lib/llm/json";
import { getLlmSettings } from "@/lib/llm/settings";
import { loadProviderCredential } from "@/lib/llm/provider-store";

export type ChatCompleteInput = {
  system: string;
  user: string;
  model: string;
  maxTokens?: number;
  baseUrl?: string;
};

export type ChatCompleteResult = {
  json: unknown;
  text: string;
  http_status: number;
  input_tokens?: number;
  output_tokens?: number;
};

function openaiText(payload: {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}): string {
  const text = payload.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error(payload.error?.message || "Provider returned empty content");
  }
  return text;
}

export async function openAiChatComplete(args: {
  url: string;
  token: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<ChatCompleteResult> {
  const res = await (args.fetchImpl ?? fetch)(args.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${args.token}`,
      ...args.headers,
    },
    body: JSON.stringify({
      model: args.model,
      temperature: 0,
      max_tokens: args.maxTokens ?? 8192,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(payload.error?.message ?? `Provider HTTP ${res.status}`);
  }
  const text = openaiText(payload);
  return {
    json: extractJsonObject(text),
    text,
    http_status: res.status,
    input_tokens: payload.usage?.prompt_tokens,
    output_tokens: payload.usage?.completion_tokens,
  };
}

export async function completeOpenRouter(
  input: ChatCompleteInput,
  fetchImpl?: typeof fetch,
): Promise<ChatCompleteResult> {
  const cred = loadProviderCredential("openrouter");
  if (!cred) throw new Error("OpenRouter is not connected. Log in on Observe.");
  const base = (input.baseUrl || getLlmSettings().provider_defaults.openrouter.base_url || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  return openAiChatComplete({
    url: `${base}/chat/completions`,
    token: cred.accessToken,
    model: input.model,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    headers: {
      "HTTP-Referer": "https://github.com/Shashb21/synapse",
      "X-Title": "Synapse IEGP",
    },
    fetchImpl,
  });
}

export async function completeGrok(
  input: ChatCompleteInput,
  fetchImpl?: typeof fetch,
): Promise<ChatCompleteResult> {
  const cred = loadProviderCredential("grok");
  if (!cred) throw new Error("Grok is not connected. Log in on Observe.");
  const base = (input.baseUrl || getLlmSettings().provider_defaults.grok.base_url || "https://api.x.ai/v1").replace(/\/$/, "");
  return openAiChatComplete({
    url: `${base}/chat/completions`,
    token: cred.accessToken,
    model: input.model,
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
    fetchImpl,
  });
}
