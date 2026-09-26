import type { OauthDescriptor } from "@/modules/llm/provider";

/**
 * Identity providers for signing in to Synapse. End-user auth is OAuth; API
 * keys are never an end-user credential.
 *
 * Only a VERIFIED email ever reaches a session (see `resolveIdentity`). Without
 * one the person is known as `provider:subject`, which can never match a
 * workspace invite or OWNER_EMAILS.
 */
export type IdentityProvider = {
  id: string;
  label: string;
  descriptor: OauthDescriptor;
  /** Where to read the profile once a token is held. */
  userinfo_url: string;
  /** Claim names, in order of preference, for a display name. */
  name_claims: string[];
  /**
   * Informational: the claim a verified email comes from. Verification rules
   * live in `resolveIdentity`; an unverified value is never used.
   */
  email_claims: string[];
  role_claim?: string;
};

type Env = Record<string, string | undefined>;

function env(name: string, source: Env = process.env): string | undefined {
  return source[name]?.trim() || undefined;
}

/** Tenants that admit accounts from any Entra ID directory (or personal accounts). */
const MULTI_TENANT = ["common", "organizations", "consumers"];

export type MicrosoftTenant = { ok: true; tenant: string } | { ok: false; tenant: string; error: string };

/**
 * The Entra ID tenant sign-in is pinned to. AZURE_TENANT_ID must name one
 * directory; "common" / "organizations" / "consumers" (or unset) are refused
 * unless MICROSOFT_ALLOW_MULTI_TENANT=1 says so explicitly.
 */
export function microsoftTenant(source: Env = process.env): MicrosoftTenant {
  const configured = env("AZURE_TENANT_ID", source);
  const allowMulti = env("MICROSOFT_ALLOW_MULTI_TENANT", source) === "1";
  const tenant = configured ?? "common";
  if (MULTI_TENANT.includes(tenant.toLowerCase()) && !allowMulti) {
    return {
      ok: false,
      tenant,
      error: configured
        ? `Microsoft sign-in is set to the multi-tenant "${tenant}" endpoint, which admits any Entra ID directory. Set AZURE_TENANT_ID to your directory (tenant) id, or set MICROSOFT_ALLOW_MULTI_TENANT=1 to allow it deliberately.`
        : "Microsoft sign-in needs AZURE_TENANT_ID (your Entra ID directory id). The multi-tenant endpoint is refused unless MICROSOFT_ALLOW_MULTI_TENANT=1.",
    };
  }
  return { ok: true, tenant };
}

const microsoftDescriptor: OauthDescriptor = {
  get authorize_url() {
    return `https://login.microsoftonline.com/${encodeURIComponent(microsoftTenant().tenant)}/oauth2/v2.0/authorize`;
  },
  get token_url() {
    return `https://login.microsoftonline.com/${encodeURIComponent(microsoftTenant().tenant)}/oauth2/v2.0/token`;
  },
  scopes: ["openid", "email", "profile", "offline_access"],
  client_id_env: "MICROSOFT_IDP_CLIENT_ID",
  client_secret_env: "MICROSOFT_IDP_CLIENT_SECRET",
  pkce: true,
};

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
    descriptor: microsoftDescriptor,
    userinfo_url: "https://graph.microsoft.com/oidc/userinfo",
    name_claims: ["name", "preferred_username", "email"],
    email_claims: ["email"],
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

/** GitHub's list of a user's addresses; only the primary verified one is used. */
export const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

export function identityProvider(id: string): IdentityProvider | undefined {
  return IDENTITY_PROVIDERS.find((provider) => provider.id === id);
}

export function idpConfigured(provider: IdentityProvider): boolean {
  return Boolean(env(provider.descriptor.client_id_env));
}

export function configuredIdentityProviders(): IdentityProvider[] {
  return IDENTITY_PROVIDERS.filter(idpConfigured);
}

/** Why this provider cannot be used for sign-in right now, or null when it can. */
export function idpRefusal(provider: IdentityProvider, source: Env = process.env): string | null {
  if (provider.id === "microsoft") {
    const tenant = microsoftTenant(source);
    if (!tenant.ok) return tenant.error;
  }
  return null;
}

/**
 * With no identity provider configured the deployment runs in demo mode: the
 * typed-name gate the app already uses stands in for a session.
 */
export function demoMode(): boolean {
  return configuredIdentityProviders().length === 0;
}

/**
 * The "continue as a demo user" sign-in exists for local preview and tests
 * only. It is never offered, and never accepted, in a production build.
 */
export function demoSignInAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

/* ------------------------------------------------------------------------- */
/* Verified identity                                                          */
/* ------------------------------------------------------------------------- */

export type ResolvedIdentity = {
  /** Always `provider:subject`. */
  subject: string;
  /** A verified, lower-cased email, or null. */
  email: string | null;
  name: string;
};

export type GithubEmail = { email?: unknown; primary?: unknown; verified?: unknown };

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalEmail(value: unknown): string | null {
  const email = str(value)?.toLowerCase();
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

/** The claims of an ID token received directly from the token endpoint over TLS. */
export function idTokenClaims(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== "string") return {};
  const payload = idToken.split(".")[1];
  if (!payload) return {};
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Who signed in, trusting only what the provider verified:
 * - Google: `email` only when `email_verified` is true.
 * - Microsoft: `email` only when the ID token/userinfo marks it verified
 *   (`email_verified`, or `xms_edov` — add that optional claim in the app
 *   registration). `preferred_username` is never an email. The ID token's
 *   tenant must be the configured one.
 * - GitHub: the primary, verified address from /user/emails.
 * Anything else leaves `email` null and the person is `provider:subject`.
 */
export function resolveIdentity(args: {
  provider: IdentityProvider;
  profile: Record<string, unknown>;
  id_token_claims?: Record<string, unknown>;
  github_emails?: GithubEmail[] | null;
  env?: Env;
}): ResolvedIdentity {
  const { provider, profile } = args;
  const claims = args.id_token_claims ?? {};
  const source = args.env ?? process.env;
  const pickName = () =>
    provider.name_claims.map((claim) => str(profile[claim] ?? claims[claim])).find(Boolean) ?? "Unnamed user";

  const rawSubject = str(profile.sub) ?? (typeof profile.id === "number" ? String(profile.id) : str(profile.id)) ?? str(claims.sub);
  if (!rawSubject) throw new Error(`${provider.label} returned no account id.`);

  let email: string | null = null;
  switch (provider.id) {
    case "google":
      if (truthy(profile.email_verified ?? claims.email_verified)) email = normalEmail(profile.email ?? claims.email);
      break;
    case "microsoft": {
      const tenant = microsoftTenant(source);
      if (!tenant.ok) throw new Error(tenant.error);
      const tid = str(claims.tid);
      const pinned = !MULTI_TENANT.includes(tenant.tenant.toLowerCase());
      if (pinned && tid && tid.toLowerCase() !== tenant.tenant.toLowerCase()) {
        throw new Error("That Microsoft account belongs to another directory.");
      }
      const verified =
        truthy(profile.email_verified) || truthy(claims.email_verified) || truthy(profile.xms_edov) || truthy(claims.xms_edov);
      if (verified) email = normalEmail(profile.email ?? claims.email);
      break;
    }
    case "github": {
      const primary = (args.github_emails ?? []).find((row) => row.primary === true && row.verified === true);
      email = primary ? normalEmail(primary.email) : null;
      break;
    }
    default:
      email = null;
  }
  return { subject: `${provider.id}:${rawSubject}`, email, name: pickName() };
}

/** ALLOWED_EMAIL_DOMAINS (comma-separated), lower-cased; empty = no allowlist. */
export function allowedEmailDomains(source: Env = process.env): string[] {
  return (source.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/**
 * Whether this verified email may sign in. With ALLOWED_EMAIL_DOMAINS set, only
 * a verified address on one of those domains (exact match) is admitted; a
 * sign-in with no verified email is refused.
 */
export function emailDomainAllowed(email: string | null, source: Env = process.env): boolean {
  const domains = allowedEmailDomains(source);
  if (domains.length === 0) return true;
  if (!email) return false;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return domains.includes(domain);
}
