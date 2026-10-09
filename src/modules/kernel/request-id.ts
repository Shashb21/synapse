import { randomUUID } from "node:crypto";

/** Header carrying a request's id (KAN-87): set by the proxy, recorded by the audit log. */
export const REQUEST_ID_HEADER = "x-request-id";

/** A request id for this request: the incoming one when sane, else a new UUID. */
export function requestIdFor(incoming: string | null | undefined): string {
  const value = incoming?.trim();
  return value && /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : randomUUID();
}
