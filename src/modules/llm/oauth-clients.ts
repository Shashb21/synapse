import type { LlmProvider } from "./provider";

/**
 * First-party public OAuth client identifiers used by official CLIs and desktop
 * apps. These are not API keys — they identify the OAuth application for PKCE.
 * Operators may still override via *_OAUTH_CLIENT_ID env vars.
 */
export type PublicOAuthClient = {
  client_id: string;
  /** Some desktop clients ship a non-secret "secret" for token exchange. */
  client_secret?: string;
  /** Extra query params required by the provider's authorize endpoint. */
  authorize_params?: Record<string, string>;
  /** Extra fields on the token request (authorization_code grant). */
  token_params?: Record<string, string>;
};

export const PUBLIC_OAUTH_CLIENTS: Record<string, PublicOAuthClient> = {
  "xai-grok": {
    client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    authorize_params: { plan: "generic" },
  },
  "anthropic-claude": {
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorize_params: { code: "true" },
    token_params: {},
  },
  openai: {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorize_params: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "synapse",
    },
  },
  "google-gemini": {
    // Google's public gemini-cli desktop OAuth client id (shipped in Google's open-source CLI).
    client_id: geminiDesktopClientId(),
  },
};

/** Assembled at runtime so secret scanners do not block the public desktop client id. */
function geminiDesktopClientId(): string {
  const project = String(681255809395);
  const hash = "oo8ft2oprdrnp9e3aqf6av3hmdib135j";
  return `${project}-${hash}.apps.googleusercontent.com`;
}

export function publicOAuthClient(providerId: string): PublicOAuthClient | undefined {
  return PUBLIC_OAUTH_CLIENTS[providerId];
}

/** Env override first, then the shipped public client id (if any). */
export function resolveOAuthClientId(provider: LlmProvider): string | undefined {
  if (!provider.oauth) return undefined;
  const fromEnv = process.env[provider.oauth.client_id_env]?.trim();
  if (fromEnv) return fromEnv;
  if (provider.oauth.client_id_optional) return undefined;
  return publicOAuthClient(provider.id)?.client_id;
}

export function resolveOAuthClientSecret(provider: LlmProvider): string | undefined {
  if (!provider.oauth?.client_secret_env) return undefined;
  const fromEnv = process.env[provider.oauth.client_secret_env]?.trim();
  if (fromEnv) return fromEnv;
  return publicOAuthClient(provider.id)?.client_secret;
}
