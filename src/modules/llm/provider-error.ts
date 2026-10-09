/**
 * A provider's HTTP failure, typed and classified (KAN-68). The message is the
 * owner's: it names the provider and what to do (add credit, replace the key,
 * wait). Customers never see it; see customerErrorMessage in
 * modules/kernel/stage-errors.ts. The API key is never part of either.
 */

export type ProviderErrorKind = "billing" | "auth" | "rate_limit" | "unavailable" | "bad_request" | "other";

export type ProviderErrorInfo = {
  provider_id: string;
  /** Short name for messages, e.g. "Anthropic". */
  provider_name: string;
  /** The env var the key comes from, e.g. ANTHROPIC_API_KEY. */
  key_env: string;
  status: number;
  /** The provider's own error type or code, e.g. invalid_request_error. */
  error_type: string | null;
  /** The provider's own error message, trimmed and with any key redacted. */
  provider_message: string | null;
  /** A 429 for a per-day quota (Gemini's free tier): waiting a minute won't help (KAN-70). */
  daily_quota?: boolean;
  /** No answer within the time limit, or no connection at all (KAN-20). Never an HTTP reply. */
  no_response?: "timeout" | "network";
};

/** Where each provider's owner adds credit. */
const BILLING_HINT: Record<string, string> = {
  "anthropic-claude": "Add credit at console.anthropic.com → Plans & Billing.",
  "xai-grok": "Add credit at console.x.ai → Billing.",
  openai: "Add credit at platform.openai.com → Settings → Billing.",
  "google-gemini": "Check billing for the project in Google AI Studio (aistudio.google.com).",
  openrouter: "Add credit at openrouter.ai → Settings → Credits.",
};

const BILLING_PATTERN =
  /credit balance|insufficient[_ ]quota|insufficient[_ ]credits?|out of credits|exceeded your current quota|billing|payment required|spending limit/i;

/**
 * Out of money, as opposed to out of requests. A 429 only counts as billing when it
 * says so outright: Gemini's free-tier 429 reads "You exceeded your current quota,
 * please check your plan and billing details" but is a rate or daily limit (KAN-70).
 */
const CREDIT_PATTERN = /credit balance|insufficient[_ ]quota|insufficient[_ ]credits?|out of credits|payment required|spending limit/i;

const AUTH_PATTERN = /api key not valid|api_key_invalid|invalid api key|incorrect api key|invalid x-api-key/i;

/** Which of the handled cases a provider failure is. Billing wins over the status code. */
export function classifyProviderError(status: number, error_type: string | null, message: string | null): ProviderErrorKind {
  const said = `${error_type ?? ""} ${message ?? ""}`;
  if (status === 402) return "billing";
  if (status === 429) return CREDIT_PATTERN.test(said) ? "billing" : "rate_limit";
  if (BILLING_PATTERN.test(said)) return "billing";
  // Google answers a bad key with HTTP 400 INVALID_ARGUMENT "API key not valid" (KAN-70).
  if (status === 401 || status === 403 || AUTH_PATTERN.test(said)) return "auth";
  if (status >= 500) return "unavailable";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  return "other";
}

/** Strips anything that looks like a credential from text a provider sent back. */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})/g, "[redacted]");
}

/** The provider's error type and message from its JSON body, whatever its shape. */
export function parseProviderErrorBody(text: string): { error_type: string | null; message: string | null } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    return { error_type: null, message: trimmed ? trimmed.slice(0, 300) : null };
  }
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const inner = record.error;
  if (typeof inner === "string") {
    return { error_type: typeof record.code === "string" ? record.code : null, message: inner };
  }
  const error = (inner && typeof inner === "object" ? inner : record) as Record<string, unknown>;
  const type = [error.type, error.code, error.status].find((value) => typeof value === "string") as string | undefined;
  const message = typeof error.message === "string" ? error.message : null;
  return { error_type: type ?? null, message };
}

function ownerMessage(info: ProviderErrorInfo, kind: ProviderErrorKind): string {
  const name = info.provider_name;
  const said = info.provider_message ? ` ${name} said: "${info.provider_message}"` : "";
  switch (kind) {
    case "billing":
      return `${name} rejected the request: the account's credit balance is too low. ${BILLING_HINT[info.provider_id] ?? `Add credit in the ${name} console.`}`;
    case "auth":
      return `${name} rejected the request: the API key in ${info.key_env} was rejected (HTTP ${info.status}). Replace it in the server environment with a valid key, then run the stage again.`;
    case "rate_limit":
      return info.daily_quota
        ? `${name} has used this model's daily request quota (HTTP 429). It resets daily; until then switch the route to another model or provider in /admin/control.${said}`
        : `${name} is rate-limiting this account (HTTP 429). Wait a minute and run the stage again, or raise the account's rate limit.${said}`;
    case "unavailable":
      if (info.no_response === "timeout") {
        return `${name} did not answer within ${describeTimeout(providerTimeoutMs())}, so the request was stopped. Run the stage again in a few minutes, or switch its route in /admin/control. The limit is SYNAPSE_LLM_TIMEOUT_MS.`;
      }
      if (info.no_response === "network") {
        return `Synapse could not reach ${name}. Check the server's network connection, then run the stage again.`;
      }
      return `${name} is overloaded or unavailable (HTTP ${info.status}). Run the stage again in a few minutes, or switch its route in /admin/control.`;
    case "bad_request":
      return `${name} rejected the request as invalid (HTTP ${info.status}${info.error_type ? `, ${info.error_type}` : ""}).${said}`;
    default:
      return `${name} returned HTTP ${info.status}${info.error_type ? ` (${info.error_type})` : ""}.${said}`;
  }
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly info: ProviderErrorInfo;

  constructor(info: ProviderErrorInfo) {
    const kind = classifyProviderError(info.status, info.error_type, info.provider_message);
    super(ownerMessage(info, kind));
    this.name = "ProviderError";
    this.kind = kind;
    this.info = info;
  }

  get status(): number {
    return this.info.status;
  }
}

/**
 * How long a provider call may take before it is stopped (KAN-20): long enough
 * for a large structured answer, short enough that a hung connection cannot
 * hold a request until the platform kills it. SYNAPSE_LLM_TIMEOUT_MS overrides.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export function providerTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.SYNAPSE_LLM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_PROVIDER_TIMEOUT_MS;
}

type ProviderTarget = { provider_id: string; provider_name: string; key_env: string };

/**
 * fetch with the provider time limit, reading the whole body under it. A
 * timeout or a failed connection becomes ProviderError "unavailable" (HTTP
 * 504 / 503 by convention, since the provider sent nothing).
 */
export async function fetchProvider(
  url: string,
  init: RequestInit,
  target: ProviderTarget,
): Promise<{ res: Response; text: string }> {
  const signal = AbortSignal.timeout(providerTimeoutMs());
  try {
    const res = await fetch(url, { ...init, signal });
    return { res, text: await res.text() };
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
    throw new ProviderError({
      ...target,
      status: timedOut ? 504 : 503,
      error_type: null,
      provider_message: null,
      no_response: timedOut ? "timeout" : "network",
    });
  }
}

/** "120 seconds", "1 second", or "250 ms" for a sub-second limit (never "0 seconds"). */
export function describeTimeout(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
