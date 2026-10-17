/** Destructive fixture writes are confined to an explicitly configured loopback e2e DB. */
export function requireDisposableDatabase(value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    // postgres-js can forward query parameters that override startup connection fields.
    if (["postgres:", "postgresql:"].includes(url.protocol) &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname === "/synapse_e2e" && !url.hash && !url.search) return value!;
  } catch { /* Fail closed for absent or malformed configuration. */ }
  throw new Error("This fixture requires an explicitly configured disposable loopback/synapse_e2e database");
}
