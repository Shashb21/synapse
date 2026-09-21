import type { OauthDescriptor } from "@/modules/llm/provider";

/**
 * Identity providers for signing in to Synapse. End-user auth is OAuth; API
 * keys are never an end-user credential.
 */
export type IdentityProvider = {
  id: string;
  label: string;
  descriptor: OauthDescriptor;
  /** Where to read the profile once a token is held. */
  userinfo_url: string;
  /** Claim names, in order of preference, for a display name. */
  name_claims: string[];
  email_claims: string[];
  role_claim?: string;
};

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const IDENTITY_PROVIDERS: IdentityProvider[] = [
  {
    id: "google",
    label: "Google",
    descriptor: {
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scopes: ["openid", "email", "profile"],
      client_id_env: "GOOGLE_IDP_CLIENT_ID",
      client_secret_env: "GOOGLE_IDP_CLIENT_SECRET",
      pkce: true,
    },
    userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo",
    name_claims: ["name", "given_name", "email"],
    email_claims: ["email"],
  },
  {
    id: "microsoft",
    label: "Microsoft Entra ID",
    descriptor: {
      authorize_url: `https://login.microsoftonline.com/${env("AZURE_TENANT_ID") ?? "common"}/oauth2/v2.0/authorize`,
      token_url: `https://login.microsoftonline.com/${env("AZURE_TENANT_ID") ?? "common"}/oauth2/v2.0/token`,
      scopes: ["openid", "email", "profile", "offline_access"],
      client_id_env: "MICROSOFT_IDP_CLIENT_ID",
      client_secret_env: "MICROSOFT_IDP_CLIENT_SECRET",
      pkce: true,
    },
    userinfo_url: "https://graph.microsoft.com/oidc/userinfo",
    name_claims: ["name", "preferred_username", "email"],
    email_claims: ["email", "preferred_username"],
    role_claim: "synapse_role",
  },
  {
    id: "github",
    label: "GitHub",
    descriptor: {
      authorize_url: "https://github.com/login/oauth/authorize",
      token_url: "https://github.com/login/oauth/access_token",
      scopes: ["read:user", "user:email"],
      client_id_env: "GITHUB_IDP_CLIENT_ID",
      client_secret_env: "GITHUB_IDP_CLIENT_SECRET",
      pkce: false,
    },
    userinfo_url: "https://api.github.com/user",
    name_claims: ["name", "login"],
    email_claims: ["email"],
  },
];

export function identityProvider(id: string): IdentityProvider | undefined {
  return IDENTITY_PROVIDERS.find((provider) => provider.id === id);
}

export function idpConfigured(provider: IdentityProvider): boolean {
  return Boolean(env(provider.descriptor.client_id_env));
}

export function configuredIdentityProviders(): IdentityProvider[] {
  return IDENTITY_PROVIDERS.filter(idpConfigured);
}

/**
 * With no identity provider configured the deployment runs in demo mode: the
 * typed-name gate the app already uses stands in for a session.
 */
export function demoMode(): boolean {
  return configuredIdentityProviders().length === 0;
}
