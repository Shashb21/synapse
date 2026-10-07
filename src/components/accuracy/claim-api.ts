/** Client helpers for the human-edit claim APIs. */

export const RATIONALE_MIN = 3;

export function rationaleError(rationale: string): string | null {
  return rationale.trim().length < RATIONALE_MIN
    ? "A short rationale is required (min 3 characters)."
    : null;
}

export async function sendJson(
  url: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null; json: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const failed = !res.ok || json.ok === false;
    return {
      ok: !failed,
      error: failed ? String(json.error ?? `Request failed (${res.status})`) : null,
      json,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Request failed",
      json: {},
    };
  }
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
