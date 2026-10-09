/**
 * Request body limits (KAN-20). A JSON API call carries form fields, or at most
 * one upload of MAX_UPLOAD_BYTES as base64 (about 4 MB), so 5 MB is enough for
 * every real request and stops a client from making the server buffer and parse
 * an arbitrarily large body. SYNAPSE_JSON_BODY_MAX_BYTES overrides it.
 */
export const DEFAULT_JSON_BODY_MAX_BYTES = 5 * 1024 * 1024;

/** The owner lab's multipart upload takes files up to 40 MB, plus the form around them. */
export const MULTIPART_BODY_MAX_BYTES = 41 * 1024 * 1024;

export function jsonBodyMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.SYNAPSE_JSON_BODY_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_JSON_BODY_MAX_BYTES;
}

function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

export function tooLargeMessage(limit: number): string {
  return `That request is over ${megabytes(limit)}, which is more than Synapse accepts at once. Send a smaller file, or paste only the part you need.`;
}

export class BodyTooLargeError extends Error {
  readonly status = 413;
  readonly code = "too_large";
  constructor(readonly limit: number) {
    super(tooLargeMessage(limit));
    this.name = "BodyTooLargeError";
  }
}

/** The most a request to this path may send, by its content type; null when unlimited here. */
export function bodyLimitFor(pathname: string, contentType: string | null): number | null {
  if (!pathname.startsWith("/api/")) return null;
  if ((contentType ?? "").toLowerCase().startsWith("multipart/form-data")) return MULTIPART_BODY_MAX_BYTES;
  return jsonBodyMaxBytes();
}

/** True when the declared Content-Length is over the limit (the cheap check, before reading). */
export function declaredTooLarge(contentLength: string | null, limit: number): boolean {
  if (!contentLength) return false;
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > limit;
}

/**
 * The body as text, refusing it as soon as it passes `limit` bytes, so a body
 * sent without (or lying about) Content-Length is still cut off.
 */
export async function readBodyText(request: Request, limit = jsonBodyMaxBytes()): Promise<string> {
  if (declaredTooLarge(request.headers.get("content-length"), limit)) throw new BodyTooLargeError(limit);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
