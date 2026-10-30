/** Client helpers for the human-edit claim APIs. */

import { postJson, type PostResult } from "@/lib/post-json";

export const RATIONALE_MIN = 3;

export function rationaleError(rationale: string): string | null {
  return rationale.trim().length < RATIONALE_MIN
    ? "A short rationale is required (min 3 characters)."
    : null;
}

/** Send a claim edit while keeping an unconfirmed write visible to its caller. */
export async function sendJson(
  url: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null; json: Record<string, unknown>; outcome: PostResult<unknown>["outcome"] }> {
  const result = await postJson<Record<string, unknown>>(url, body, { method });
  const failed = !result.ok || result.json.ok === false;
  const error = failed
    ? result.json.safe_error === true && typeof result.json.error === "string"
      ? result.json.error
      : "We couldn't confirm the claim update. Check the current claim before trying again."
    : null;
  return {
    ok: !failed,
    error,
    json: failed ? { ...result.json, error } : result.json,
    outcome: result.ok && failed ? "unknown" : result.outcome,
  };
}

/** Empty inputs → null so a cleared field is saved as cleared. */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function splitIds(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}
