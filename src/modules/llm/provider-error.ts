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

/** Which of the handled cases a provider failure is. Billing wins over the status code. */
export function classifyProviderError(status: number, error_type: string | null, message: string | null): ProviderErrorKind {
  if (status === 402 || BILLING_PATTERN.test(`${error_type ?? ""} ${message ?? ""}`)) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
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
      return `${name} is rate-limiting this account (HTTP 429). Wait a minute and run the stage again, or raise the account's rate limit.${said}`;
    case "unavailable":
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
