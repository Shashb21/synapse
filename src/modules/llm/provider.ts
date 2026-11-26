import { providerBaseUrl } from "./provider-endpoint";
import { fetchProvider, ModelAnswerError, ProviderError, parseProviderErrorBody, redactSecrets } from "./provider-error";

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

/**
 * Token usage from raw provider parsing or resolved call recording. Raw parsers
 * leave missing counts null. Successful recorded calls fill missing counts from
 * text estimates and label their origin; failed calls retain reported counts only.
 * Input includes cached prompt and tool-use prompt tokens. Output includes billed reasoning tokens.
 * Origin fields are optional so historical records remain readable. Estimates
 * describe approximate usage, not confirmed provider billing.
 */
export type LlmUsage = {
  /** Count origin; absent on historical records and raw provider payloads. */
  source?: "provider" | "estimated" | "mixed";
  /** Earlier HTTP attempts may have incurred unreported charges. */
  prior_charge_unknown?: boolean;
  /** Present total or reasoning metadata failed numeric or structural validation. */
  malformed_token_details?: true;
  /** Reported by adapters whose service tier can affect billing. */
  service_tier?: string;
  inference_geo?: string;
  cached_input_tokens?: number | null;
  cache_written_input_tokens?: number | null;
  cost_in_usd_ticks?: number | null;
  input_tokens_source?: "provider" | "estimated";
  output_tokens_source?: "provider" | "estimated";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  /** Of the output, the reasoning tokens, when the provider says. */
  reasoning_tokens: number | null;
};

/** A shared allowance for outbound HTTP requests, including retries. */
export type ProviderRequestBudget = {
  check(lastFailure?: Pick<ProviderError, "kind" | "status">): void;
  consume(): void;
};

/** Optional observers of one call. The reply is still returned as plain text. */
export type LlmCallHooks = {
  requestBudget?: ProviderRequestBudget;
  run?: { signal: AbortSignal; deadline: number; checkAttempt(): void; dispatch<T>(send: () => Promise<T>, reserve?: () => void): Promise<T> };
  onDispatch?: () => void;
  onUsage?: (usage: LlmUsage) => void;
  /** Per-call HTTP bound; omitted preserves ordinary provider retry policy. */
  maxAttempts?: number;
  /** Check that the caller still owns the work before another HTTP send. */
  beforeRetry?: () => Promise<void>;
  /** Prevent account defaults from selecting a premium tier on a reserved send. */
  standardBilling?: boolean;
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
  /**
   * Returns raw assistant text. JSON parsing is the caller's job. `hooks.onUsage`
   * hears the provider's token counts, when it reports them (KAN-91).
   */
  complete(request: LlmRequest, auth: LlmAuth | null, hooks?: LlmCallHooks): Promise<string>;
  /** False when this model is called without `temperature` (Claude 5, KAN-71). Absent means it is sent. */
  sendsTemperature?(model: string): boolean;
};

export class NoRouteError extends Error {}

export { ModelAnswerError, ProviderError } from "./provider-error";

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
  sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

/** How long the provider asked us to wait, in ms, or null. */
function requestedWait(res: Response, text: string): number | null {
  const header = res.headers.get("retry-after")?.trim();
  if (header) {
    if (/^\d+(?:\.\d+)?$/.test(header)) return Number(header) * 1_000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return delay ? Number(delay[1]) * 1_000 : null;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, target: CallTarget, hooks?: LlmCallHooks) {
  const maxAttempts = hooks?.maxAttempts ?? RETRY.attempts;
  for (let attempt = 1; ; attempt += 1) {
    // Time-limited (SYNAPSE_LLM_TIMEOUT_MS); a timeout is "unavailable" and not retried (KAN-20).
    const reserve = () => hooks?.requestBudget?.consume();
    const send = () => {
      hooks?.onDispatch?.();
      return fetchProvider(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: hooks?.run?.signal,
      }, target);
    };
    if (!hooks?.run) reserve();
    const { res, text } = await (hooks?.run ? hooks.run.dispatch(send, reserve) : send());
    if (res.ok) return JSON.parse(text) as Record<string, unknown>;
    // A typed, classified error instead of the raw body; the key never appears in it.
    const redirected = res.status >= 300 && res.status < 400;
    const parsed = redirected ? { error_type: null, message: null } : parseProviderErrorBody(text);
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
    if (!transient || attempt >= maxAttempts) throw error;
    // When a retry cannot be sent, retain only the safe classification from the paid attempt.
    hooks?.requestBudget?.check({ kind: error.kind, status: error.status });
    hooks?.run?.checkAttempt();
    const wait = requestedWait(res, text) ?? Math.min(RETRY.base_ms * 2 ** (attempt - 1), RETRY.max_wait_ms);
    if (wait > RETRY.max_wait_ms || (hooks?.run && Date.now() + wait >= hooks.run.deadline)) throw error;
    await RETRY.sleep(wait, hooks?.run?.signal);
    await hooks?.beforeRetry?.();
  }
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Optional billed components may be absent. A missing or invalid base count is unknown. */
function billedCount(base: unknown, ...extras: unknown[]): number | null {
  let total = count(base);
  if (total === null) return null;
  for (const extra of extras) {
    if (extra === undefined) continue;
    const component = count(extra);
    if (component === null) return null;
    total += component;
  }
  return count(total);
}

/** The provider's token counts from a reply payload, whatever its shape; null when it sent none. */
export function usageFromPayload(payload: Record<string, unknown>): LlmUsage | null {
  const gemini = payload.usageMetadata as Record<string, unknown> | undefined;
  if (gemini && typeof gemini === "object") {
    // GenerateContent's total includes tool-use prompts and thoughts. Cached
    // tokens are already in promptTokenCount.
    const prompt = count(gemini.promptTokenCount);
    const input = billedCount(prompt, gemini.toolUsePromptTokenCount);
    const output = billedCount(gemini.candidatesTokenCount, gemini.thoughtsTokenCount);
    const total = count(gemini.totalTokenCount);
    const hasCacheCount = Object.hasOwn(gemini, "cachedContentTokenCount");
    const cached = count(gemini.cachedContentTokenCount);
    const reconciled = total !== null && total === billedCount(input, output)
      && (!hasCacheCount || (cached !== null && prompt !== null && cached <= prompt));
    const tier = typeof gemini.serviceTier === "string" ? gemini.serviceTier.toLowerCase() : "";
    return {
      input_tokens: reconciled ? input : null,
      output_tokens: reconciled ? output : null,
      total_tokens: reconciled ? total : null,
      reasoning_tokens: reconciled ? count(gemini.thoughtsTokenCount) : null,
      ...(hasCacheCount ? { cached_input_tokens: cached } : {}),
      ...(Object.hasOwn(gemini, "serviceTier") ? {
        service_tier: ["standard", "unspecified", "flex", "priority"].includes(tier) ? tier : "unknown",
      } : {}),
    };
  }
  const usage = payload.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const charge = Object.hasOwn(usage, "cost_in_usd_ticks") ? { cost_in_usd_ticks: count(usage.cost_in_usd_ticks) } : {};
  if ("input_tokens" in usage || "output_tokens" in usage) {
    // Anthropic: cached prompt tokens are reported apart from input_tokens.
    const input = billedCount(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
    const output = count(usage.output_tokens);
    return {
      input_tokens: input, output_tokens: output, total_tokens: billedCount(input, output), reasoning_tokens: null,
      ...charge,
      ...(Object.hasOwn(usage, "cache_read_input_tokens") ? { cached_input_tokens: count(usage.cache_read_input_tokens) } : {}),
      ...(Object.hasOwn(usage, "cache_creation_input_tokens") ? { cache_written_input_tokens: count(usage.cache_creation_input_tokens) } : {}),
      ...(typeof usage.inference_geo === "string" ? { inference_geo: usage.inference_geo } : {}),
      ...(typeof usage.service_tier === "string" ? { service_tier: usage.service_tier } : {}),
    };
  }
  // OpenAI-compatible (OpenAI, OpenRouter, xAI).
  const input = count(usage.prompt_tokens);
  const output = count(usage.completion_tokens);
  const total = count(usage.total_tokens);
  const details = usage.completion_tokens_details;
  const breakdown = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : null;
  const reasoning = count(breakdown?.reasoning_tokens);
  const malformedDetails = (Object.hasOwn(usage, "total_tokens") && total === null)
    || (Object.hasOwn(usage, "completion_tokens_details") && !breakdown)
    || (breakdown && Object.hasOwn(breakdown, "reasoning_tokens") && reasoning === null);
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total ?? billedCount(input, output),
    reasoning_tokens: reasoning,
    ...(malformedDetails ? { malformed_token_details: true } : {}),
    ...(promptDetails && Object.hasOwn(promptDetails, "cached_tokens") ? { cached_input_tokens: count(promptDetails.cached_tokens) } : {}),
    ...charge,
    ...(typeof payload.service_tier === "string" ? { service_tier: payload.service_tier } : {}),
  };
}

/** Tells the hook what the call used, before the reply is checked (a cut-off reply still cost tokens). */
function reportUsage(payload: Record<string, unknown>, hooks: LlmCallHooks | undefined) {
  if (!hooks?.onUsage) return;
  const usage = usageFromPayload(payload);
  if (usage) hooks.onUsage(usage);
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
  hooks?: LlmCallHooks;
}): Promise<string> {
  const payload = await postJson(
    `${args.base.replace(/\/$/, "")}/chat/completions`,
    { authorization: `Bearer ${args.auth.api_key}`, ...args.headers },
    {
      model: args.request.model,
      temperature: args.request.temperature,
      max_tokens: args.request.max_tokens,
      ...(args.hooks?.standardBilling && ["openai", "xai-grok"].includes(args.target.provider_id) ? { service_tier: "default" } : {}),
      messages: [
        { role: "system", content: args.request.system },
        { role: "user", content: args.request.user },
      ],
      ...(args.target.provider_id === "openrouter" ? { provider: { allow_fallbacks: false } } : {}),
      ...(args.json ? { response_format: { type: "json_object" } } : {}),
    },
    { ...args.target, api_key: args.auth.api_key },
    args.hooks,
  );
  reportUsage(payload, args.hooks);
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
  const choice = (payload.choices as { message?: { refusal?: string } }[] | undefined)?.[0];
  if (finish === "content_filter" || choice?.message?.refusal) {
    throw new ModelAnswerError("refusal", `${target.provider_name} declined this request.`);
  }
  if (finish === "length") {
    throw new ModelAnswerError("truncation",
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
  async complete(request, auth, hooks) {
    if (!auth) throw new NoRouteError("xai-grok has no API key: set XAI_API_KEY");
    return chatCompletions({
      base: providerBaseUrl("xai-grok"),
      request,
      auth,
      hooks,
      target: { provider_id: "xai-grok", provider_name: "xAI", key_env: "XAI_API_KEY" },
    });
  },
};

/**
 * Whether a Claude model still takes `temperature`. Claude 5 models and Opus
 * 4.7/4.8 return a 400 for sampling parameters; older models accept them (KAN-71).
 */
export function anthropicAcceptsTemperature(model: string): boolean {
  return !/^claude-(?:(?:opus|sonnet|fable|mythos)-5|opus-4-[78])(?:-|$)/.test(model);
}

/**
 * The answer text of a Messages API response, or a clear error (KAN-71).
 * Thinking blocks are skipped. With adaptive thinking one answer can arrive as
 * several text blocks; they are one continuous answer, so they are joined with
 * nothing in between (a newline would land inside JSON strings). A refusal or
 * a reply cut off at max_tokens is never usable, so it is an error, not text.
 */
export function anthropicText(payload: Record<string, unknown>): string {
  const stop = payload.stop_reason;
  if (stop === "refusal") {
    const details = payload.stop_details as { category?: string | null } | null | undefined;
    throw new ModelAnswerError("refusal", `Claude declined this request${details?.category ? ` (${details.category})` : ""}.`);
  }
  const content = Array.isArray(payload.content) ? (payload.content as { type?: string; text?: string }[]) : [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") {
    throw new ModelAnswerError("truncation",
      text.trim()
        ? "Claude's reply was cut off at its max_tokens limit before it finished. Raise Max tokens for this stage in AI & routing."
        : "Claude used its whole max_tokens budget before answering. Raise Max tokens for this stage in AI & routing.",
    );
  }
  if (!text.trim()) throw new Error("Claude returned no answer text.");
  return text;
}

/** The locked one-click alternate: Anthropic Claude, reached with `x-api-key`. */
export const anthropicClaude: LlmProvider = {
  id: "anthropic-claude",
  label: "Anthropic · Claude",
  summary: "One-click alternate. Claude models on api.anthropic.com, using the server's Anthropic API key.",
  auth: "api_key",
  tier: "alternate",
  models: models("ANTHROPIC_MODELS", ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"]),
  default_model: models("ANTHROPIC_MODELS", ["claude-sonnet-5-5"])[0]!,
  sendsTemperature: anthropicAcceptsTemperature,
  async complete(request, auth, hooks) {
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
      `${providerBaseUrl("anthropic-claude").replace(/\/$/, "")}/v1/messages`,
      headers,
      {
        model: request.model,
        max_tokens: request.max_tokens,
        ...(hooks?.standardBilling ? { service_tier: "standard_only" } : {}),
        // Claude 5 models (and Opus 4.7/4.8) reject sampling parameters with a 400.
        ...(anthropicAcceptsTemperature(request.model) ? { temperature: request.temperature } : {}),
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      },
      { provider_id: "anthropic-claude", provider_name: "Anthropic", key_env: "ANTHROPIC_API_KEY", api_key: auth.api_key },
      hooks,
    );
    reportUsage(payload, hooks);
    return anthropicText(payload);
  },
};

export const openAi: LlmProvider = {
  id: "openai",
  label: "OpenAI · ChatGPT",
  summary: "GPT models on api.openai.com, using the server's OpenAI API key.",
  auth: "api_key",
  models: models("OPENAI_MODELS", ["gpt-5.1", "gpt-5.1-mini", "o4-mini"]),
  default_model: models("OPENAI_MODELS", ["gpt-5.1"])[0]!,
  async complete(request, auth, hooks) {
    if (!auth) throw new NoRouteError("openai has no API key: set OPENAI_API_KEY");
    return chatCompletions({
      base: providerBaseUrl("openai"),
      request,
      auth,
      hooks,
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
  async complete(request, auth, hooks) {
    if (!auth) throw new NoRouteError("google-gemini has no API key: set GEMINI_API_KEY");
    const payload = await postJson(
      `${providerBaseUrl("google-gemini").replace(/\/$/, "")}/models/${request.model}:generateContent`,
      { "x-goog-api-key": auth.api_key },
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        ...(hooks?.standardBilling ? { serviceTier: "standard" } : {}),
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.max_tokens,
          // Every Synapse stage parses a JSON object from the reply (KAN-70).
          responseMimeType: "application/json",
        },
      },
      { provider_id: "google-gemini", provider_name: "Google Gemini", key_env: "GEMINI_API_KEY", api_key: auth.api_key },
      hooks,
    );
    reportUsage(payload, hooks);
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
  if (blocked) throw new ModelAnswerError("refusal", `Gemini blocked the prompt (${blocked}). Nothing was saved.`);
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new ModelAnswerError("truncation",
      "Gemini's reply was cut off at its max_tokens limit (its thinking counts toward it). Raise Max tokens for this stage in AI & routing.",
    );
  }
  if (candidate?.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) {
    if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"].includes(candidate.finishReason)) {
      throw new ModelAnswerError("refusal", `Gemini stopped early (${candidate.finishReason}). Nothing was saved.`);
    }
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
  async complete(request, auth, hooks) {
    if (!auth) throw new NoRouteError("openrouter has no API key: set OPENROUTER_API_KEY");
    return chatCompletions({
      base: providerBaseUrl("openrouter"),
      request,
      auth,
      hooks,
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
