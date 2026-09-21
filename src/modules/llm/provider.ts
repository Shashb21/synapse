/**
 * LLM provider contract. Cloud providers authenticate with OAuth; API keys are
 * not part of the end-user path. A provider is a plug-in: adding one never
 * touches stage logic, only this registry.
 */

export type OauthDescriptor = {
  /** Authorization endpoint. Overridable per deployment. */
  authorize_url: string;
  token_url: string;
  scopes: string[];
  /** Env var holding the OAuth client id. Secrets never live in the repo. */
  client_id_env: string;
  client_secret_env?: string;
  /** PKCE is used whenever the provider supports it. */
  pkce: boolean;
  docs_url?: string;
};

export type LlmRequest = {
  system: string;
  user: string;
  model: string;
  temperature: number;
  max_tokens: number;
};

export type LlmAuth = { access_token: string };

export type LlmProvider = {
  id: string;
  label: string;
  summary: string;
  auth: "oauth" | "none";
  models: string[];
  default_model: string;
  oauth?: OauthDescriptor;
  /** Returns raw assistant text. JSON parsing is the caller's job. */
  complete(request: LlmRequest, auth: LlmAuth | null): Promise<string>;
};

export class NoRouteError extends Error {}

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
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

function messagesText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
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
            .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
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
  throw new Error("Provider returned no text content");
}

/** Anthropic messages API reached with an OAuth bearer token. */
export const anthropicOauth: LlmProvider = {
  id: "anthropic-oauth",
  label: "Anthropic (OAuth)",
  summary: "Claude models via an OAuth bearer token. Endpoints configurable per deployment.",
  auth: "oauth",
  models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  default_model: "claude-sonnet-4-5",
  oauth: {
    authorize_url: env("ANTHROPIC_OAUTH_AUTHORIZE_URL", "https://claude.ai/oauth/authorize"),
    token_url: env("ANTHROPIC_OAUTH_TOKEN_URL", "https://console.anthropic.com/v1/oauth/token"),
    scopes: ["user:inference"],
    client_id_env: "ANTHROPIC_OAUTH_CLIENT_ID",
    pkce: true,
    docs_url: "https://docs.anthropic.com",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("anthropic-oauth is not connected");
    const payload = await postJson(
      env("ANTHROPIC_BASE_URL", "https://api.anthropic.com") + "/v1/messages",
      {
        authorization: `Bearer ${auth.access_token}`,
        "anthropic-version": "2023-06-01",
      },
      {
        model: request.model,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      },
    );
    return messagesText(payload);
  },
};

/** Azure OpenAI reached with a Microsoft Entra ID access token. */
export const azureOpenAiOauth: LlmProvider = {
  id: "azure-openai-oauth",
  label: "Azure OpenAI (Entra ID)",
  summary: "Azure-hosted OpenAI deployments authorized by Microsoft Entra ID.",
  auth: "oauth",
  models: ["gpt-4.1", "gpt-4o", "o4-mini"],
  default_model: "gpt-4.1",
  oauth: {
    authorize_url: `https://login.microsoftonline.com/${env("AZURE_TENANT_ID", "common")}/oauth2/v2.0/authorize`,
    token_url: `https://login.microsoftonline.com/${env("AZURE_TENANT_ID", "common")}/oauth2/v2.0/token`,
    scopes: ["https://cognitiveservices.azure.com/.default", "offline_access"],
    client_id_env: "AZURE_OAUTH_CLIENT_ID",
    client_secret_env: "AZURE_OAUTH_CLIENT_SECRET",
    pkce: true,
    docs_url: "https://learn.microsoft.com/azure/ai-services/openai",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("azure-openai-oauth is not connected");
    const base = env("AZURE_OPENAI_ENDPOINT");
    if (!base) throw new NoRouteError("AZURE_OPENAI_ENDPOINT is not set");
    const version = env("AZURE_OPENAI_API_VERSION", "2024-10-21");
    const payload = await postJson(
      `${base.replace(/\/$/, "")}/openai/deployments/${request.model}/chat/completions?api-version=${version}`,
      { authorization: `Bearer ${auth.access_token}` },
      {
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      },
    );
    return messagesText(payload);
  },
};

/** Gemini on Vertex AI reached with a Google Cloud OAuth token. */
export const googleVertexOauth: LlmProvider = {
  id: "google-vertex-oauth",
  label: "Google Vertex AI (OAuth)",
  summary: "Gemini models on Vertex AI authorized by a Google Cloud OAuth consent flow.",
  auth: "oauth",
  models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  default_model: "gemini-2.5-pro",
  oauth: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    client_id_env: "GOOGLE_OAUTH_CLIENT_ID",
    client_secret_env: "GOOGLE_OAUTH_CLIENT_SECRET",
    pkce: true,
    docs_url: "https://cloud.google.com/vertex-ai/docs",
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("google-vertex-oauth is not connected");
    const project = env("GOOGLE_CLOUD_PROJECT");
    const location = env("GOOGLE_CLOUD_LOCATION", "us-central1");
    if (!project) throw new NoRouteError("GOOGLE_CLOUD_PROJECT is not set");
    const payload = await postJson(
      `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${request.model}:generateContent`,
      { authorization: `Bearer ${auth.access_token}` },
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.max_tokens,
        },
      },
    );
    return messagesText(payload);
  },
};

/** Any OpenAI-compatible gateway behind an OAuth authorization server. */
export const openAiCompatibleOauth: LlmProvider = {
  id: "openai-compatible-oauth",
  label: "OpenAI-compatible gateway (OAuth)",
  summary: "Self-hosted or vendor gateway speaking /chat/completions with an OAuth bearer token.",
  auth: "oauth",
  models: env("LLM_GATEWAY_MODELS", "gpt-4.1,llama-3.3-70b")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean),
  default_model: env("LLM_GATEWAY_MODELS", "gpt-4.1").split(",")[0]!.trim(),
  oauth: {
    authorize_url: env("LLM_GATEWAY_AUTHORIZE_URL", "https://gateway.example.com/oauth/authorize"),
    token_url: env("LLM_GATEWAY_TOKEN_URL", "https://gateway.example.com/oauth/token"),
    scopes: (env("LLM_GATEWAY_SCOPES", "inference") || "inference").split(" "),
    client_id_env: "LLM_GATEWAY_CLIENT_ID",
    client_secret_env: "LLM_GATEWAY_CLIENT_SECRET",
    pkce: true,
  },
  async complete(request, auth) {
    if (!auth) throw new NoRouteError("openai-compatible-oauth is not connected");
    const base = env("LLM_GATEWAY_BASE_URL");
    if (!base) throw new NoRouteError("LLM_GATEWAY_BASE_URL is not set");
    const payload = await postJson(
      `${base.replace(/\/$/, "")}/chat/completions`,
      { authorization: `Bearer ${auth.access_token}` },
      {
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      },
    );
    return messagesText(payload);
  },
};

/**
 * No-network route. Selecting it tells agentic stages to use their deterministic
 * proposer, so the pipeline is end-to-end before any provider is connected.
 */
export const deterministicProvider: LlmProvider = {
  id: "deterministic-local",
  label: "Deterministic (no LLM)",
  summary: "Runs each agentic stage's local proposer, critic and judge. No credentials, no network.",
  auth: "none",
  models: ["local-heuristic"],
  default_model: "local-heuristic",
  async complete() {
    throw new NoRouteError(
      "deterministic-local does not call an LLM; the stage must use its local proposer",
    );
  },
};

export const PROVIDERS: LlmProvider[] = [
  deterministicProvider,
  anthropicOauth,
  azureOpenAiOauth,
  googleVertexOauth,
  openAiCompatibleOauth,
];

export function findProvider(id: string): LlmProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** True when the deployment has the OAuth client configuration this provider needs. */
export function providerConfigured(provider: LlmProvider): boolean {
  if (provider.auth === "none") return true;
  if (!provider.oauth) return false;
  return Boolean(process.env[provider.oauth.client_id_env]?.trim());
}
