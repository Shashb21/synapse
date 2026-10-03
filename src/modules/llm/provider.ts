import { ProviderError, parseProviderErrorBody, redactSecrets } from "./provider-error";

/**
 * LLM provider contract. Every cloud provider authenticates with a server-side
 * API key from the environment (see ./api-keys.ts); there is no provider login
 * (KAN-65). Adding a provider touches this file and the env map in api-keys.ts;
 * no stage logic changes.
 *
 * MVP providers (locked): xAI (Grok, default), Anthropic (Claude, one-click
 * alternate), OpenAI, Google (Gemini), OpenRouter.
 */

export type LlmRequest = {
  system: string;
  user: string;
  model: string;
  temperature: number;
  max_tokens: number;
};

/** The provider's API key, read on the server and sent only to that provider. */
export type LlmAuth = {
  api_key: string;
};

export type LlmProvider = {
  id: string;
  label: string;
  summary: string;
  auth: "api_key" | "none";
  models: string[];
  default_model: string;
  /** Marks the two locked first-class defaults for the one-click switch. */
  tier?: "default" | "alternate";
  /** Returns raw assistant text. JSON parsing is the caller's job. */
  complete(request: LlmRequest, auth: LlmAuth | null): Promise<string>;
};

export class NoRouteError extends Error {}

export { ProviderError } from "./provider-error";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function models(envName: string, fallback: string[]): string[] {
  const raw = env(envName);
  if (!raw) return fallback;
  const list = raw.split(",").map((model) => model.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

/** Who a call goes to, for a typed error when it fails (KAN-68). */
type CallTarget = { provider_id: string; provider_name: string; key_env: string; api_key: string };

/**
 * A 429 or 503 is retried a few times, waiting what the provider asks for (Retry-After,
 * or Gemini's RetryInfo) or a growing backoff, capped. Free tiers allow only a few
 * requests a minute (KAN-70). Billing, auth and per-day quota errors are never retried.
 */
export const RETRY = {
  attempts: 4,
  base_ms: 2_000,
  max_wait_ms: 60_000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** How long the provider asked us to wait, in ms, or null. */
function requestedWait(res: Response, text: string): number | null {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1_000;
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return delay ? Number(delay[1]) * 1_000 : null;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, target: CallTarget) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as Record<string, unknown>;
    // A typed, classified error instead of the raw body; the key never appears in it.
    const parsed = parseProviderErrorBody(text);
    const error = new ProviderError({
      provider_id: target.provider_id,
      provider_name: target.provider_name,
      key_env: target.key_env,
      status: res.status,
      error_type: parsed.error_type,
      provider_message: parsed.message ? redactSecrets(parsed.message, [target.api_key]).slice(0, 300) : null,
      // Gemini names the quota it hit, e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier.
      // OpenRouter's free models say "free-models-per-day" (KAN-70).
      daily_quota: res.status === 429 && /PerDay|per[- ]day/i.test(text),
    });
    // Gemini's free tier also answers "high demand" 503s and, now and then, a 404 with no
    // body for a model it serves; a real "model not found" always carries an error body.
    const transient =
      (error.kind === "rate_limit" && !error.info.daily_quota) || res.status === 503 || (res.status === 404 && !text.trim());
    if (!transient || attempt >= RETRY.attempts) throw error;
    const wait = requestedWait(res, text) ?? RETRY.base_ms * 2 ** (attempt - 1);
    await RETRY.sleep(Math.min(wait, RETRY.max_wait_ms));
  }
}

function textFromPayload(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part && "text" in part
          ? String((part as { text?: string }).text ?? "")
          : "",
      )
      .join("\n");
  }
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    return choices
      .map((choice) => {
        const message = (choice as { message?: { content?: unknown } }).message;
        if (typeof message?.content === "string") return message.content;
        if (Array.isArray(message?.content)) {
          return message.content
            .map((part) =>
              typeof part === "object" && part && "text" in part
                ? String((part as { text?: string }).text ?? "")
                : "",
            )
            .join("\n");
        }
        return "";
      })
      .join("\n");
  }
  const candidates = payload.candidates;
  if (Array.isArray(candidates)) {
    return candidates
      .map((candidate) => {
        const parts = (candidate as { content?: { parts?: { text?: string }[] } }).content?.parts ?? [];
        return parts.map((part) => part.text ?? "").join("\n");
      })
      .join("\n");
  }
  const output = payload.output;
  if (Array.isArray(output)) {
    return output
      .flatMap((item) => (item as { content?: { text?: string }[] }).content ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
  }
  throw new Error("Provider returned no text content");
}

/** OpenAI-compatible /chat/completions call with the API key as a bearer token. */
async function chatCompletions(args: {
  base: string;
  request: LlmRequest;
  auth: LlmAuth;
  target: Omit<CallTarget, "api_key">;
  headers?: Record<string, string>;
  /** Ask for a JSON object reply (OpenAI-compatible `response_format`). */
  json?: boolean;
}): Promise<string> {
  const payload = await postJson(
    `${args.base.replace(/\/$/, "")}/chat/completions`,
    { authorization: `Bearer ${args.auth.api_key}`, ...args.headers },
    {
      model: args.request.model,
      temperature: args.request.temperature,
      max_tokens: args.request.max_tokens,
      messages: [
        { role: "system", content: args.request.system },
        { role: "user", content: args.request.user },
      ],
      ...(args.json ? { response_format: { type: "json_object" } } : {}),
    },
    { ...args.target, api_key: args.auth.api_key },
  );
  return chatText(payload, { ...args.target, api_key: args.auth.api_key });
}

/**
 * The reply text, or a clear error: an upstream error OpenRouter sends inside an HTTP 200,
 * or a reply cut off at max_tokens (reasoning tokens count toward it) (KAN-70).
 */
export function chatText(payload: Record<string, unknown>, target: CallTarget): string {
  const error = payload.error as { code?: unknown; message?: unknown } | undefined;
  if (error && typeof error === "object") {
    const status = typeof error.code === "number" ? error.code : 502;
    throw new ProviderError({
      provider_id: target.provider_id,
      provider_name: target.provider_name,
      key_env: target.key_env,
      status,
      error_type: null,
      provider_message:
        typeof error.message === "string" ? redactSecrets(error.message, [target.api_key]).slice(0, 300) : null,
    });
  }
  const finish = (payload.choices as { finish_reason?: string }[] | undefined)?.[0]?.finish_reason;
  if (finish === "length") {
    throw new Error(
      `${target.provider_name}'s reply was cut off at its max_tokens limit. Raise Max tokens for this stage in AI & routing.`,
    );
  }
  return textFromPayload(payload);
}

/** Default route: xAI Grok, reached with XAI_API_KEY as a bearer token. */
export const xaiGrok: LlmProvider = {
  id: "xai-grok",
  label: "xAI · Grok",
  summary: "Default route. Grok models on api.x.ai, using the server's xAI API key.",
  auth: "api_key",
  tier: "default",
  models: models("XAI_MODELS", ["grok-4", "grok-4-fast", "grok-3"]),
  default_model: models("XAI_MODELS", ["grok-4"])[0]!,
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("xai-grok has no API key: set XAI_API_KEY");
    return chatCompletions({
      base: env("XAI_BASE_URL", "https://api.x.ai/v1"),
      request,
      auth,
      target: { provider_id: "xai-grok", provider_name: "xAI", key_env: "XAI_API_KEY" },
    });
  },
};

/** The locked one-click alternate: Anthropic Claude, reached with `x-api-key`. */
export const anthropicClaude: LlmProvider = {
  id: "anthropic-claude",
  label: "Anthropic · Claude",
  summary: "One-click alternate. Claude models on api.anthropic.com, using the server's Anthropic API key.",
  auth: "api_key",
  tier: "alternate",
  models: models("ANTHROPIC_MODELS", ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"]),
  default_model: models("ANTHROPIC_MODELS", ["claude-sonnet-5-5"])[0]!,
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("anthropic-claude has no API key: set ANTHROPIC_API_KEY");
    const headers: Record<string, string> = {
      "x-api-key": auth.api_key,
      "anthropic-version": "2023-06-01",
    };
    // Org-level API keys require an explicit Anthropic workspace (not Synapse workspace).
    const anthropicWorkspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
    if (anthropicWorkspaceId) {
      headers["anthropic-workspace-id"] = anthropicWorkspaceId;
    }
    const payload = await postJson(
      `${env("ANTHROPIC_BASE_URL", "https://api.anthropic.com")}/v1/messages`,
      headers,
      {
        model: request.model,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      },
      { provider_id: "anthropic-claude", provider_name: "Anthropic", key_env: "ANTHROPIC_API_KEY", api_key: auth.api_key },
    );
    return textFromPayload(payload);
  },
};

export const openAi: LlmProvider = {
  id: "openai",
  label: "OpenAI · ChatGPT",
  summary: "GPT models on api.openai.com, using the server's OpenAI API key.",
  auth: "api_key",
  models: models("OPENAI_MODELS", ["gpt-5.1", "gpt-5.1-mini", "o4-mini"]),
  default_model: models("OPENAI_MODELS", ["gpt-5.1"])[0]!,
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("openai has no API key: set OPENAI_API_KEY");
    return chatCompletions({
      base: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
      request,
      auth,
      target: { provider_id: "openai", provider_name: "OpenAI", key_env: "OPENAI_API_KEY" },
    });
  },
};

/** Gemini on the Generative Language API: the key travels in `x-goog-api-key`. */
export const googleGemini: LlmProvider = {
  id: "google-gemini",
  label: "Google · Gemini",
  summary: "Gemini models on the Generative Language API, using the server's Gemini API key.",
  auth: "api_key",
  // gemini-2.5-* is closed to new keys (Google, Oct 2026).
  models: models("GEMINI_MODELS", ["gemini-3.8-flash", "gemini-3.1-pro-preview"]),
  default_model: models("GEMINI_MODELS", ["gemini-3.8-flash"])[0]!,
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("google-gemini has no API key: set GEMINI_API_KEY");
    const payload = await postJson(
      `${env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")}/models/${request.model}:generateContent`,
      { "x-goog-api-key": auth.api_key },
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.max_tokens,
          // Every Synapse stage parses a JSON object from the reply (KAN-70).
          responseMimeType: "application/json",
        },
      },
      { provider_id: "google-gemini", provider_name: "Google Gemini", key_env: "GEMINI_API_KEY", api_key: auth.api_key },
    );
    return geminiText(payload);
  },
};

/**
 * Gemini's text, or a clear error when it stopped early: cut off at the output budget
 * (thinking tokens count toward it), or blocked. Otherwise a cut-off reply would surface
 * later as a confusing "invalid JSON" (KAN-70).
 */
export function geminiText(payload: Record<string, unknown>): string {
  const candidate = (payload.candidates as { finishReason?: string }[] | undefined)?.[0];
  const blocked = (payload.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
  if (blocked) throw new Error(`Gemini blocked the prompt (${blocked}). Nothing was saved.`);
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error(
      "Gemini's reply was cut off at its max_tokens limit (its thinking counts toward it). Raise Max tokens for this stage in AI & routing.",
    );
  }
  if (candidate?.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) {
    throw new Error(`Gemini stopped early (${candidate.finishReason}). Nothing was saved.`);
  }
  return textFromPayload(payload);
}

/** Any OpenRouter-hosted model, reached with OPENROUTER_API_KEY as a bearer token. */
export const openRouter: LlmProvider = {
  id: "openrouter",
  label: "OpenRouter",
  summary: "Any OpenRouter-hosted model, using the server's OpenRouter API key.",
  auth: "api_key",
  models: models("OPENROUTER_MODELS", [
    "x-ai/grok-4",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.1",
    "google/gemini-2.5-pro",
  ]),
  default_model: models("OPENROUTER_MODELS", ["x-ai/grok-4"])[0]!,
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("openrouter has no API key: set OPENROUTER_API_KEY");
    return chatCompletions({
      base: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
      request,
      auth,
      target: { provider_id: "openrouter", provider_name: "OpenRouter", key_env: "OPENROUTER_API_KEY" },
      // Every stage parses a JSON object; models that can't honour it ignore the hint.
      json: true,
      headers: {
        "http-referer": env("OPENROUTER_APP_URL", "https://github.com/Shashb21/synapse"),
        "x-title": "Synapse IEGP",
      },
    });
  },
};

export const PROVIDERS: LlmProvider[] = [xaiGrok, anthropicClaude, openAi, googleGemini, openRouter];

/** Locked: Grok is the default route, Claude the one-click alternate. */
export const DEFAULT_ROUTE_PROVIDER = xaiGrok.id;
export const ALTERNATE_ROUTE_PROVIDER = anthropicClaude.id;
/** Standing fallbacks after the preferred provider (Claude, then OpenAI). */
export const DEFAULT_ROUTE_FALLBACKS = [anthropicClaude.id, openAi.id] as const;

export function findProvider(id: string): LlmProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** True when the provider lists this model (a provider that lists none serves any). */
export function providerServes(provider: LlmProvider, model: string): boolean {
  return provider.models.length === 0 || provider.models.includes(model);
}

/**
 * The model a stored route actually uses. A route saved before the provider's
 * list changed may name a model it no longer serves; it keeps working on the
 * provider's default instead of failing at call time (KAN-65).
 */
export function servedModel(provider: LlmProvider, model: string | null | undefined): string {
  return model && providerServes(provider, model) ? model : provider.default_model;
}
