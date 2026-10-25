/** Cold module caches must never turn a rejected replacement into initialization writes. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
  set: (name: string, value: string) => void jar.set(name, value),
}), headers: async () => new Headers() }));
import "@/modules";
import { createSession, sessionKey, SESSION_COOKIE } from "@/modules/auth/session";
import { createAccount } from "@/modules/auth/accounts";
import { assignSeats, createCustomer } from "@/modules/auth/customers";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import { createWorkspace } from "@/modules/workspaces/store";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/modules/workspaces/context";
const identities: Record<string, { cookies: Map<string, string>; target: string }> = {};
const allowedKinds = ["demo", "staff", "password-seat", "sso-seat", "sso-admin", "owner-email"];
const rejectedKinds = ["expired", "revoked-staff", "forged-selection", "missing-session"];
beforeAll(async () => {
  // Even with the anonymous-test opt-in, an actual session cookie must be verified.
  vi.stubEnv("SYNAPSE_TEST_ANON_API", "1");
  const unique = crypto.randomUUID();
  for (const kind of allowedKinds) {
    const email = `cold-${kind}-${unique}@example.com`;
    const account = ["staff", "password-seat", "sso-admin"].includes(kind)
      ? await createAccount({ email, name: kind, password: "copper-meadow-signal-4", email_verified: true, is_admin: kind !== "password-seat", role: "medical_affairs", created_by: "test" }) : null;
    if (["password-seat", "sso-seat"].includes(kind)) {
      const customer = await createCustomer({ name: `Cold ${kind} ${unique}`, seats: 1 });
      await assignSeats({ customer_id: customer.id, emails: [email], by: "test" });
    }
    if (kind === "owner-email") vi.stubEnv("OWNER_EMAILS", email);
    const target = (await createWorkspace({ name: "Cold target", owner: email })).id;
    const selected = (await createWorkspace({ name: "Cold selected", owner: email })).id;
    const session = await createSession({ provider_id: kind === "demo" ? "demo" : ["staff", "password-seat"].includes(kind) ? "password" : "oidc", subject: account?.id ?? email, email, actor_name: "Cold owner", actor_function: "medical_affairs", role: "medical_affairs" });
    jar.set(WORKSPACE_COOKIE, workspaceCookieValue(selected, session.id));
    identities[kind] = { cookies: new Map(jar), target };
  }
  // The expired record must be refused without cleanup writes during preflight.
  const expired = await createSession({ provider_id: "demo", subject: "expired", actor_name: "Expired", actor_function: "medical_affairs", role: "medical_affairs" });
  await sharedDb().execute(sql`update auth_sessions set expires_at = '2000-01-01T00:00:00.000Z' where id = ${sessionKey(expired.id)}`);
  identities.expired = { cookies: new Map([[SESSION_COOKIE, expired.id]]), target: identities.demo.target };
  const revoked = await createAccount({ email: `revoked-${unique}@example.com`, name: "Revoked", password: "copper-meadow-signal-4", is_admin: true, created_by: "test" });
  const revokedSession = await createSession({ provider_id: "password", subject: revoked.id, actor_name: "Revoked", actor_function: "medical_affairs", role: "medical_affairs" });
  await sharedDb().execute(sql`update user_accounts set disabled = true where id = ${revoked.id}`);
  identities["revoked-staff"] = { cookies: new Map([[SESSION_COOKIE, revokedSession.id]]), target: identities.demo.target };

}, 60_000);
afterAll(() => { vi.unstubAllEnvs(); jar.clear(); });
it.each(["reset", "load_demo"].flatMap(action => [...allowedKinds, ...rejectedKinds].map(kind => [action, kind])))("%s rejects %s with cold platform and store caches using only reads", async (action, kind) => {
  const fixture = identities[kind === "forged-selection" || kind === "missing-session" ? "demo" : kind];
  jar.clear();
  for (const [key, value] of fixture.cookies) jar.set(key, value);
  if (kind === "forged-selection") jar.set(WORKSPACE_COOKIE, `${jar.get(WORKSPACE_COOKIE)}tampered`);
  if (kind === "missing-session") jar.set(SESSION_COOKIE, "not-a-live-session");
  const invalidSession = ["expired", "revoked-staff", "missing-session"].includes(kind);
  const expectedCode = invalidSession ? "no_session" : kind === "forged-selection" ? "no_workspace" : "workspace_mismatch";
  // Arrange: existing persisted identity, but none of the process initialization promises.
  vi.resetModules();
  const globalPlatform = globalThis as unknown as { synapsePlatformSchema?: Promise<void> };
  delete globalPlatform.synapsePlatformSchema;
  const database = await import("@/lib/iegp/db");
  const { POST } = await import("@/app/api/iegp/route");
  const dialect = new PgDialect();
  const queries: string[] = [];
  const shared = database.sharedDb();
  const original = shared.execute.bind(shared);
  const execute = vi.spyOn(shared, "execute").mockImplementation((query) => {
    queries.push(typeof query === "string" ? query : dialect.sqlToQuery(query.getSQL()).sql);
    return original(query);
  });
  const mutations = [vi.spyOn(shared, "insert"), vi.spyOn(shared, "update"), vi.spyOn(shared, "delete")];
  const workspaceExecute = vi.spyOn(database.db(), "execute");
  const schema = vi.spyOn(database, "currentSchemaName");
  try {
    // Act: real session and signed cookie; no explicit workspace scope bypasses cookie verification.
    const response = await POST(new Request("http://localhost/api/iegp", { method: "POST", body: JSON.stringify({ action, expected_workspace_id: fixture.target }) }));
    // Assert: observe actual issued SQL, including the lazy platform/store DDL entry points.
    expect(response.status).toBe(invalidSession ? 401 : 409);
    expect(await response.json()).toMatchObject({ code: expectedCode });
    if (allowedKinds.includes(kind)) expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(query => /^\s*select\b/i.test(query))).toBe(true);
    expect(globalPlatform.synapsePlatformSchema).toBeUndefined();
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(workspaceExecute).not.toHaveBeenCalled();
    expect(schema).not.toHaveBeenCalled();
  } finally {
    execute.mockRestore();
    for (const mutation of mutations) mutation.mockRestore();
    workspaceExecute.mockRestore(); schema.mockRestore();
  }
});
