import { resolveOAuthClientId } from "./oauth-clients";
import { hasProviderApiKey } from "./api-keys";

/**
 * LLM provider contract. Every cloud provider authenticates by OAuth login in
 * the control panel — API keys are not part of the product path. Adding a
 * provider touches this file only; no stage logic changes.
 *
 * MVP providers (locked): xAI (Grok, default), Anthropic (Claude, one-click
 * alternate), OpenAI, Google (Gemini), OpenRouter.
 */

export type OauthDescriptor = {
  authorize_url: string;
  token_url: string;
  scopes: string[];
  /** Optional env override for the OAuth client id (built-in public ids ship by default). */
  client_id_env: string;
  client_secret_env?: string;
  pkce: boolean;
  /** Some providers accept a client-less PKCE flow (OpenRouter). */
  client_id_optional?: boolean;
  /** Query parameter carrying the redirect URI. OpenRouter uses `callback_url`. */
  redirect_param?: string;
  /** Providers that reject the standard authorize parameters. */
  omit_client_id?: boolean;
  omit_response_type?: boolean;
  omit_scope?: boolean;
  /** How the token request is encoded, and which field carries the token. */
  token_style?: "form" | "json";
  token_field?: string;
  docs_url?: string;
};

export type LlmRequest = {
  system: string;
  user: string;
  model: string;
  temperature: number;
  max_tokens: number;
};

export type LlmAuth = {
  access_token: string;
  /** OAuth bearer by default; Anthropic API keys use `x-api-key` instead. */
  kind?: "oauth" | "api_key";
};

export type LlmProvider = {
  id: string;
  label: string;
  summary: string;
  auth: "oauth" | "none";
  models: string[];
  default_model: string;
  /** Marks the two locked first-class defaults for the one-click switch. */
  tier?: "default" | "alternate";
  oauth?: OauthDescriptor;
  /** Returns raw assistant text. JSON parsing is the caller's job. */
  complete(request: LlmRequest, auth: LlmAuth | null): Promise<string>;
};

export class NoRouteError extends Error {}

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function models(envName: string, fallback: string[]): string[] {
  const raw = env(envName);
  if (!raw) return fallback;
  const list = raw.split(",").map((model) => model.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${new URL(url).host} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
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

/** OpenAI-compatible /chat/completions call with a bearer token. */
async function chatCompletions(args: {
  base: string;
  request: LlmRequest;
  auth: LlmAuth;
  headers?: Record<string, string>;
}): Promise<string> {
  const payload = await postJson(
    `${args.base.replace(/\/$/, "")}/chat/completions`,
    { authorization: `Bearer ${args.auth.access_token}`, ...args.headers },
    {
      model: args.request.model,
      temperature: args.request.temperature,
      max_tokens: args.request.max_tokens,
      messages: [
        { role: "system", content: args.request.system },
        { role: "user", content: args.request.user },
      ],
    },
  );
  return textFromPayload(payload);
}

/** Default route: xAI Grok, reached with an OAuth bearer token. */
export const xaiGrok: LlmProvider = {
  id: "xai-grok",
  label: "xAI · Grok",
  summary: "Default route. Grok models on api.x.ai, authorized by xAI OAuth login in the control panel.",
  auth: "oauth",
  tier: "default",
  models: models("XAI_MODELS", ["grok-4", "grok-4-fast", "grok-3"]),
  default_model: models("XAI_MODELS", ["grok-4"])[0]!,
  oauth: {
    authorize_url: env("XAI_OAUTH_AUTHORIZE_URL", "https://auth.x.ai/oauth2/authorize"),
    token_url: env("XAI_OAUTH_TOKEN_URL", "https://auth.x.ai/oauth2/token"),
    scopes: env(
      "XAI_OAUTH_SCOPES",
      "openid profile email offline_access grok-cli:access api:access",
    )
      .split(" ")
      .filter(Boolean),
    client_id_env: "XAI_OAUTH_CLIENT_ID",
    client_secret_env: "XAI_OAUTH_CLIENT_SECRET",
    pkce: true,
    docs_url: "https://docs.x.ai",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("xai-grok is not connected");
    return chatCompletions({
      base: env("XAI_BASE_URL", "https://api.x.ai/v1"),
      request,
      auth,
    });
  },
};

/** The locked one-click alternate: Anthropic Claude. */
export const anthropicClaude: LlmProvider = {
  id: "anthropic-claude",
  label: "Anthropic · Claude",
  summary: "One-click alternate. Claude models on api.anthropic.com, authorized by Anthropic OAuth login.",
  auth: "oauth",
  tier: "alternate",
  models: models("ANTHROPIC_MODELS", ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"]),
  default_model: models("ANTHROPIC_MODELS", ["claude-sonnet-4-5"])[0]!,
  oauth: {
    authorize_url: env("ANTHROPIC_OAUTH_AUTHORIZE_URL", "https://claude.ai/oauth/authorize"),
    token_url: env("ANTHROPIC_OAUTH_TOKEN_URL", "https://console.anthropic.com/v1/oauth/token"),
    scopes: env("ANTHROPIC_OAUTH_SCOPES", "user:inference user:profile").split(" ").filter(Boolean),
    client_id_env: "ANTHROPIC_OAUTH_CLIENT_ID",
    pkce: true,
    docs_url: "https://docs.anthropic.com",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("anthropic-claude is not connected");
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };
    if (auth.kind === "api_key") {
      headers["x-api-key"] = auth.access_token;
    } else {
      headers.authorization = `Bearer ${auth.access_token}`;
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
    );
    return textFromPayload(payload);
  },
};

export const openAi: LlmProvider = {
  id: "openai",
  label: "OpenAI · ChatGPT",
  summary: "GPT models on api.openai.com, authorized by OpenAI OAuth login.",
  auth: "oauth",
  models: models("OPENAI_MODELS", ["gpt-5.1", "gpt-5.1-mini", "o4-mini"]),
  default_model: models("OPENAI_MODELS", ["gpt-5.1"])[0]!,
  oauth: {
    authorize_url: env("OPENAI_OAUTH_AUTHORIZE_URL", "https://auth.openai.com/oauth/authorize"),
    token_url: env("OPENAI_OAUTH_TOKEN_URL", "https://auth.openai.com/oauth/token"),
    scopes: env("OPENAI_OAUTH_SCOPES", "openid profile email offline_access api.request")
      .split(" ")
      .filter(Boolean),
    client_id_env: "OPENAI_OAUTH_CLIENT_ID",
    client_secret_env: "OPENAI_OAUTH_CLIENT_SECRET",
    pkce: true,
    docs_url: "https://platform.openai.com/docs",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("openai is not connected");
    return chatCompletions({
      base: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
      request,
      auth,
    });
  },
};

export const googleGemini: LlmProvider = {
  id: "google-gemini",
  label: "Google · Gemini",
  summary: "Gemini models on the Generative Language API, authorized by Google OAuth login.",
  auth: "oauth",
  models: models("GEMINI_MODELS", ["gemini-2.5-pro", "gemini-2.5-flash"]),
  default_model: models("GEMINI_MODELS", ["gemini-2.5-pro"])[0]!,
  oauth: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scopes: env("GOOGLE_OAUTH_SCOPES", "https://www.googleapis.com/auth/cloud-platform")
      .split(" ")
      .filter(Boolean),
    client_id_env: "GOOGLE_OAUTH_CLIENT_ID",
    client_secret_env: "GOOGLE_OAUTH_CLIENT_SECRET",
    pkce: true,
    docs_url: "https://ai.google.dev/gemini-api/docs",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("google-gemini is not connected");
    const project = env("GOOGLE_CLOUD_PROJECT");
    const payload = await postJson(
      `${env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")}/models/${request.model}:generateContent`,
      {
        authorization: `Bearer ${auth.access_token}`,
        ...(project ? { "x-goog-user-project": project } : {}),
      },
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.max_tokens,
        },
      },
    );
    return textFromPayload(payload);
  },
};

/** OpenRouter's client-less PKCE flow exchanges the code for a scoped key. */
export const openRouter: LlmProvider = {
  id: "openrouter",
  label: "OpenRouter",
  summary: "Any OpenRouter-hosted model, authorized by the OpenRouter OAuth (PKCE) login.",
  auth: "oauth",
  models: models("OPENROUTER_MODELS", [
    "x-ai/grok-4",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.1",
    "google/gemini-2.5-pro",
  ]),
  default_model: models("OPENROUTER_MODELS", ["x-ai/grok-4"])[0]!,
  oauth: {
    authorize_url: env("OPENROUTER_OAUTH_AUTHORIZE_URL", "https://openrouter.ai/auth"),
    token_url: env("OPENROUTER_OAUTH_TOKEN_URL", "https://openrouter.ai/api/v1/auth/keys"),
    scopes: [],
    client_id_env: "OPENROUTER_OAUTH_CLIENT_ID",
    pkce: true,
    client_id_optional: true,
    redirect_param: "callback_url",
    omit_client_id: true,
    omit_response_type: true,
    omit_scope: true,
    token_style: "json",
    token_field: "key",
    docs_url: "https://openrouter.ai/docs/use-cases/oauth-pkce",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("openrouter is not connected");
    return chatCompletions({
      base: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
      request,
      auth,
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

/** True when this provider can start OAuth (built-in public client or env override). */
export function providerConfigured(provider: LlmProvider): boolean {
  if (provider.auth === "none") return true;
  if (!provider.oauth) return false;
  if (provider.oauth.client_id_optional) return true;
  return Boolean(resolveOAuthClientId(provider));
}

/** True when OAuth is ready or a server-side API key is injected for this provider. */
export function providerRoutable(provider: LlmProvider): boolean {
  if (provider.auth === "none") return true;
  if (providerConfigured(provider)) return true;
  return hasProviderApiKey(provider.id);
}
