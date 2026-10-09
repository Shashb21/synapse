/**
 * A browser POST that never throws (KAN-18). A dropped connection or a reply
 * that is not JSON comes back as a failed result with a message, so a dialog
 * can show it and leave "Saving…" instead of sticking there.
 */

export const NETWORK_ERROR = "Could not reach Synapse. Check your connection and try again.";

export type PostResult<T> = {
  ok: boolean;
  /** 0 when the request never got an answer. */
  status: number;
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
    return { ok: false, status: 0, json: { error: NETWORK_ERROR } as PostResult<T>["json"] };
  }
  const json = (await res.json().catch(() => ({}))) as PostResult<T>["json"];
  return { ok: res.ok, status: res.status, json };
}
