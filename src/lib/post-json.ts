/**
 * A browser POST that never throws (KAN-18). A dropped connection or a reply
 * that is not JSON comes back as a failed result with a message, so a dialog
 * can show it and leave "Saving…" instead of sticking there.
 */

export const NETWORK_ERROR = "We couldn't confirm the result. Check your connection and check the current state before trying again.";

export type PostResult<T> = {
  ok: boolean;
  /** 0 when the request never got an answer. */
  status: number;
  outcome: "confirmed" | "rejected" | "unknown";
  json: Partial<T> & { error?: string };
};

export async function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  init: RequestInit = {},
): Promise<PostResult<T>> {
  const form = typeof FormData !== "undefined" && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      ...init,
      headers: form ? init.headers : { "content-type": "application/json", ...init.headers },
      body: form ? body : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, outcome: "unknown", json: { error: NETWORK_ERROR } as PostResult<T>["json"] };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    return { ok: false, status: res.status, outcome: "unknown", json: { error: NETWORK_ERROR } as PostResult<T>["json"] };
  }
  const json = parsed as PostResult<T>["json"] & { safe_error?: boolean; request_outcome?: "rejected" };
  const ok = res.ok && (json as { ok?: boolean }).ok !== false;
  if (!ok && (json.safe_error !== true || typeof json.error !== "string")) {
    json.error = "We couldn't complete this action. Check the current state before trying again. If this continues, contact your Synapse administrator.";
  }
  return { ok, status: res.status, outcome: ok ? "confirmed" : json.safe_error === true && json.request_outcome === "rejected" ? "rejected" : "unknown", json };
}

/** A failed request carrying whether its result could be confirmed. Never retry automatically. */
export class RequestOutcomeError extends Error {
  constructor(message: string, readonly outcome: PostResult<unknown>["outcome"], readonly status: number) {
    super(message);
    this.name = "RequestOutcomeError";
  }
}

/** Preserve only errors issued by the safe browser request boundary. */
export function requestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof RequestOutcomeError ? error.message : fallback;
}
