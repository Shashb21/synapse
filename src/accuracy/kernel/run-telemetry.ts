/** Project untrusted processing input into byte-free structured run telemetry. */
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

const STRING_METADATA_KEYS = ["workspace_id", "source_file_id", "filename", "mime", "checksum"] as const;

/** Remove document payload keys recursively without mutating processing values. */
export function sanitizeRunTelemetry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRunTelemetry);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "content_base64")
      .map(([key, nested]) => [key, sanitizeRunTelemetry(nested)]));
  }
  return value;
}

/**
 * Allow only typed parse metadata; derive missing fingerprints from transient bytes.
 *
 * Parameters
 * ----------
 * input : unknown
 *     Untrusted parser input. Extras are never considered safe metadata.
 *
 * Returns
 * -------
 * Record<string, string | number>
 *     Identifiers, file description, SHA-256 checksum and decoded byte count.
 *     Invalid metadata is omitted; the parser remains responsible for validation.
 */
export function parseRunMetadata(input: unknown): Record<string, string | number> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const metadata: Record<string, string | number> = {};
  for (const key of STRING_METADATA_KEYS) {
    if (typeof record[key] === "string") metadata[key] = record[key];
  }
  if (typeof record.byte_count === "number" && Number.isSafeInteger(record.byte_count) && record.byte_count >= 0) {
    metadata.byte_count = record.byte_count;
  }
  if (typeof record.content_base64 === "string" && (!metadata.checksum || metadata.byte_count === undefined)) {
    const bytes = Buffer.from(record.content_base64, "base64");
    metadata.checksum ??= createHash("sha256").update(bytes).digest("hex");
    metadata.byte_count ??= bytes.length;
  }
  return metadata;
}

/**
 * Project historic JSONB in PostgreSQL, so document bytes never reach the reader.
 * Only typed metadata survives; legacy missing fingerprints remain missing.
 */
export function historicParseMetadata(input: SQL): SQL<unknown> {
  const fields = STRING_METADATA_KEYS.map((key) => sql`case when jsonb_typeof(${input}->${key}) = 'string' then jsonb_build_object(${key}::text, ${input}->${key}) else '{}'::jsonb end`);
  fields.push(sql`case when jsonb_typeof(${input}->'byte_count') = 'number' then
    case when (${input}->>'byte_count')::numeric between 0 and 9007199254740991
      and trunc((${input}->>'byte_count')::numeric) = (${input}->>'byte_count')::numeric
      then jsonb_build_object('byte_count', ${input}->'byte_count') else '{}'::jsonb end
    else '{}'::jsonb end`);
  return sql<unknown>`(${sql.join(fields, sql` || `)})`;
}
