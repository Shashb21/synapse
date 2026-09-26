import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory cookie jar standing in for the browser. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import { sql } from "drizzle-orm";
import { sharedDb } from "@/lib/iegp/db";
import { register } from "@/instrumentation";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  allowedEmailDomains,
  emailDomainAllowed,
  identityProvider,
  microsoftTenant,
  resolveIdentity,
  type IdentityProvider,
} from "@/modules/auth/idp";
import { ownerDecision } from "@/modules/auth/roles";
import { assertSessionSecret, DEV_SESSION_SECRET, MissingSessionSecretError, sessionSecret } from "@/modules/auth/secret";
import { beginLogin, completeLogin, currentSession, demoEmail, loginIdentity, signInDemo } from "@/modules/auth/session";
import { verifyWorkspaceCookie, workspaceCookieValue, WORKSPACE_COOKIE_TTL_MS } from "@/modules/workspaces/context";
import { principalOf } from "@/modules/workspaces/session";
import {
  claimDefaultWorkspace,
  createWorkspace,
  DEFAULT_WORKSPACE_ID,
  getWorkspace,
  inviteMember,
  listMembers,
  memberRole,
} from "@/modules/workspaces/store";

const STRONG = "k".repeat(24) + "-strong-secret-for-tests";
const unique = () => Math.random().toString(36).slice(2, 8);
const google = identityProvider("google") as IdentityProvider;
const microsoft = identityProvider("microsoft") as IdentityProvider;
const github = identityProvider("github") as IdentityProvider;

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function req(url: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => jar.clear());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("KAN-11: SESSION_SECRET in production", () => {
  it("refuses to run in production without a strong secret", () => {
    expect(() => sessionSecret({ NODE_ENV: "production" })).toThrow(MissingSessionSecretError);
    expect(() => sessionSecret({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET is not set/);
    expect(() => sessionSecret({ NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow(/too short/);
    expect(() => sessionSecret({ NODE_ENV: "production", SESSION_SECRET: DEV_SESSION_SECRET })).toThrow(/development default/);
    expect(sessionSecret({ NODE_ENV: "production", SESSION_SECRET: `  ${STRONG}  ` })).toBe(STRONG);
    expect(sessionSecret({ NODE_ENV: "production", AUTH_SECRET: STRONG })).toBe(STRONG);
  });

  it("fails at server startup (instrumentation register) but not during next build", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => register()).toThrow(/SESSION_SECRET/);
    expect(() => assertSessionSecret({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).not.toThrow();
    vi.stubEnv("SESSION_SECRET", STRONG);
    expect(() => register()).not.toThrow();
  });

  it("keeps a development fallback outside production", () => {
    expect(sessionSecret({ NODE_ENV: "development" })).toBe(DEV_SESSION_SECRET);
    expect(sessionSecret({ NODE_ENV: "test" })).toBe(DEV_SESSION_SECRET);
    expect(sessionSecret({ NODE_ENV: "development", SESSION_SECRET: "dev" })).toBe("dev");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("AUTH_SECRET", "");
    const value = workspaceCookieValue("wdev", "session-dev");
    expect(verifyWorkspaceCookie(value, "session-dev")).toBe("wdev");
  });
});

describe("KAN-11: workspace cookie expiry and forgery", () => {
  it("binds the cookie to an expiry and rejects it once expired", () => {
    const now = Date.now();
    const value = workspaceCookieValue("wexp", "session-1", { now });
    expect(value.split(".")).toHaveLength(3);
    expect(verifyWorkspaceCookie(value, "session-1", now + 1000)).toBe("wexp");
    expect(verifyWorkspaceCookie(value, "session-1", now + WORKSPACE_COOKIE_TTL_MS + 1)).toBeNull();
    const short = workspaceCookieValue("wexp", "session-1", { now: now - 10_000, ttlMs: 5_000 });
    expect(verifyWorkspaceCookie(short, "session-1")).toBeNull();
  });

  it("rejects a tampered expiry and the old unexpiring format", () => {
    const now = Date.now();
    const value = workspaceCookieValue("wexp", "session-1", { now, ttlMs: 1000 });
    const [id, , sig] = value.split(".");
    expect(verifyWorkspaceCookie(`${id}.${now + 10 ** 10}.${sig}`, "session-1", now)).toBeNull();
    const legacySig = createHmac("sha256", DEV_SESSION_SECRET).update("default.session-1").digest("base64url");
    expect(verifyWorkspaceCookie(`default.${legacySig}`, "session-1")).toBeNull();
  });

  it("in production, a cookie forged with the public default secret is rejected", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", STRONG);
    const exp = Date.now() + 60_000;
    const forgedSig = createHmac("sha256", DEV_SESSION_SECRET)
      .update(`${DEFAULT_WORKSPACE_ID}.${exp}.attacker-session`)
      .digest("base64url");
    expect(verifyWorkspaceCookie(`${DEFAULT_WORKSPACE_ID}.${exp}.${forgedSig}`, "attacker-session")).toBeNull();
    // A genuine cookie under the real secret still verifies.
    expect(verifyWorkspaceCookie(workspaceCookieValue("default", "real-session"), "real-session")).toBe("default");
    // And without a secret, production never falls back to the default: it refuses.
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => verifyWorkspaceCookie(`${DEFAULT_WORKSPACE_ID}.${exp}.${forgedSig}`, "attacker-session")).toThrow(
      /SESSION_SECRET/,
    );
  });
});

describe("KAN-12: only verified emails identify a person", () => {
  it("Google: an unverified email is dropped; the principal is google:<sub>", async () => {
    const victim = `victim-${unique()}@example.com`;
    const unverified = resolveIdentity({
      provider: google,
      profile: { sub: "g-123", email: victim, email_verified: false, name: "Mallory" },
    });
    expect(unverified).toEqual({ subject: "google:g-123", email: null, name: "Mallory" });
    const principal = principalOf({ ...unverified, provider_id: "google" });
    expect(principal).toBe("google:g-123");

    // An invite for the victim's email, and OWNER_EMAILS naming it, do not match.
    const ws = await createWorkspace({ name: "Invite target", owner: `owner-${unique()}@example.com` });
    await inviteMember({ workspace_id: ws.id, email: victim, by: ws.created_by });
    expect(await memberRole(ws.id, principal)).toBeNull();
    expect(
      ownerDecision(
        { role: "medical_affairs", email: unverified.email, signed_in: true, demo: false, provider_id: "google" },
        { emails: [victim], bypass: false },
      ).owner,
    ).toBe(false);

    const verified = resolveIdentity({
      provider: google,
      profile: { sub: "g-456", email: "Lead@Example.com", email_verified: true },
    });
    expect(verified.email).toBe("lead@example.com");
    expect(principalOf({ ...verified, provider_id: "google" })).toBe("lead@example.com");
  });

  it("Microsoft: never preferred_username; email only when verified; tenant must match", async () => {
    const env = { AZURE_TENANT_ID: "11111111-2222-3333-4444-555555555555" };
    const victim = `ms-victim-${unique()}@example.com`;
    const unverified = resolveIdentity({
      provider: microsoft,
      profile: { sub: "m-1", email: victim, preferred_username: victim, name: "Eve" },
      id_token_claims: { tid: env.AZURE_TENANT_ID },
      env,
    });
    expect(unverified.email).toBeNull();
    expect(unverified.subject).toBe("microsoft:m-1");
    const ws = await createWorkspace({ name: "MS invite target", owner: `owner-${unique()}@example.com` });
    await inviteMember({ workspace_id: ws.id, email: victim, by: ws.created_by });
    expect(await memberRole(ws.id, principalOf({ ...unverified, provider_id: "microsoft" }))).toBeNull();
    expect(
      ownerDecision(
        { role: "medical_affairs", email: unverified.email, signed_in: true, demo: false, provider_id: "microsoft" },
        { emails: [victim], bypass: false },
      ).owner,
    ).toBe(false);

    const onlyUpn = resolveIdentity({
      provider: microsoft,
      profile: { sub: "m-2", preferred_username: victim },
      id_token_claims: { xms_edov: true },
      env,
    });
    expect(onlyUpn.email).toBeNull();

    const verified = resolveIdentity({
      provider: microsoft,
      profile: { sub: "m-3", email: "Lead@Example.com" },
      id_token_claims: { tid: env.AZURE_TENANT_ID, xms_edov: true },
      env,
    });
    expect(verified.email).toBe("lead@example.com");

    expect(() =>
      resolveIdentity({
        provider: microsoft,
        profile: { sub: "m-4", email: "x@example.com" },
        id_token_claims: { tid: "another-tenant", xms_edov: true },
        env,
      }),
    ).toThrow(/another directory/);
  });

  it("GitHub: only the primary verified address from /user/emails", () => {
    const pick = (emails: unknown[]) =>
      resolveIdentity({ provider: github, profile: { id: 42, login: "octo", email: "public@example.com" }, github_emails: emails as never });
    expect(pick([{ email: "a@example.com", primary: true, verified: true }])).toEqual({
      subject: "github:42",
      email: "a@example.com",
      name: "octo",
    });
    expect(pick([{ email: "a@example.com", primary: true, verified: false }, { email: "b@example.com", primary: false, verified: true }]).email).toBeNull();
    expect(pick([]).email).toBeNull();
  });

  it("a full Google callback with an unverified email stores google:<sub> and no email", async () => {
    vi.stubEnv("GOOGLE_IDP_CLIENT_ID", "client-id");
    await beginLogin({ provider_id: "google", redirect_uri: "http://localhost/api/auth/callback" });
    const pending = JSON.parse(jar.get("synapse_oauth_pending")!) as { state: string };
    const sub = `g-${unique()}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("token")
          ? new Response(JSON.stringify({ access_token: "at", id_token: idToken({ sub }) }))
          : new Response(JSON.stringify({ sub, email: "owner@kernel.example", email_verified: false, name: "Nope" })),
      ),
    );
    const session = await completeLogin({ code: "c", state: pending.state });
    expect(session.email).toBeNull();
    expect(session.subject).toBe(`google:${sub}`);
    expect(session.provider_id).toBe("google");
    expect(principalOf(session)).toBe(`google:${sub}`);
  });
});

describe("KAN-12: Microsoft tenant", () => {
  it("refuses the common / organizations tenant unless explicitly allowed", async () => {
    expect(microsoftTenant({}).ok).toBe(false);
    expect(microsoftTenant({ AZURE_TENANT_ID: "common" }).ok).toBe(false);
    expect(microsoftTenant({ AZURE_TENANT_ID: "organizations" }).ok).toBe(false);
    expect(microsoftTenant({ AZURE_TENANT_ID: "common", MICROSOFT_ALLOW_MULTI_TENANT: "1" }).ok).toBe(true);
    expect(microsoftTenant({ AZURE_TENANT_ID: "contoso.onmicrosoft.com" })).toEqual({ ok: true, tenant: "contoso.onmicrosoft.com" });

    vi.stubEnv("MICROSOFT_IDP_CLIENT_ID", "ms-client");
    vi.stubEnv("AZURE_TENANT_ID", "");
    await expect(beginLogin({ provider_id: "microsoft", redirect_uri: "http://localhost/cb" })).rejects.toThrow(
      /AZURE_TENANT_ID/,
    );
    vi.stubEnv("AZURE_TENANT_ID", "common");
    await expect(beginLogin({ provider_id: "microsoft", redirect_uri: "http://localhost/cb" })).rejects.toThrow(/multi-tenant/);

    vi.stubEnv("AZURE_TENANT_ID", "contoso-tenant-id");
    const { authorize_url } = await beginLogin({ provider_id: "microsoft", redirect_uri: "http://localhost/cb" });
    expect(authorize_url.startsWith("https://login.microsoftonline.com/contoso-tenant-id/oauth2/v2.0/authorize")).toBe(true);
  });
});

describe("KAN-12: demo sign-in cannot choose its privileges", () => {
  it("outside the test stub, body role and email are ignored: a contributor at the demo address", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    vi.stubEnv("OWNER_EMAILS", "boss@kernel.example");
    const name = `Demo ${unique()}`;
    const res = await loginPost(
      req("/api/auth/login", { demo: true, actor_name: name, role: "operator", email: "boss@kernel.example" }),
    );
    expect(res.status).toBe(200);
    const session = (await currentSession())!;
    expect(session.role).toBe("contributor");
    expect(session.email).toBe(demoEmail(name));
    expect(
      ownerDecision({ role: session.role, email: session.email, signed_in: true, demo: true, provider_id: "demo" }).owner,
    ).toBe(false);
    // Even a typed OWNER_EMAILS address on a demo session is not the owner.
    expect(
      ownerDecision(
        { role: "contributor", email: "boss@kernel.example", signed_in: true, demo: true, provider_id: "demo" },
        { emails: ["boss@kernel.example"], bypass: false },
      ).owner,
    ).toBe(false);
  });

  it("under the test stub a requested role is honoured, but never operator", async () => {
    const asOperator = await signInDemo({ actor_name: `Stub ${unique()}`, actor_function: "medical_affairs", role: "operator" });
    expect(asOperator.role).toBe("medical_affairs");
    const asViewer = await signInDemo({ actor_name: `Stub ${unique()}`, actor_function: "medical_affairs", role: "viewer" });
    expect(asViewer.role).toBe("viewer");
    const byFunction = await signInDemo({ actor_name: `Stub ${unique()}`, actor_function: "heor" });
    expect(byFunction.role).toBe("contributor");
  });
});

describe("KAN-12: claiming the Default workspace", () => {
  it("concurrent first sign-ins yield exactly one owner", async () => {
    const db = sharedDb();
    await getWorkspace(DEFAULT_WORKSPACE_ID); // ensure tables
    const savedWs = (await db.execute(sql`select * from workspaces where id = ${DEFAULT_WORKSPACE_ID}`)) as unknown as Record<string, unknown>[];
    const savedMembers = (await db.execute(
      sql`select * from workspace_members where workspace_id = ${DEFAULT_WORKSPACE_ID}`,
    )) as unknown as Record<string, unknown>[];
    try {
      await db.execute(sql`delete from workspace_members where workspace_id = ${DEFAULT_WORKSPACE_ID}`);
      await db.execute(sql`delete from workspaces where id = ${DEFAULT_WORKSPACE_ID}`);
      const racers = Array.from({ length: 8 }, (_, i) => `racer-${i}-${unique()}@example.com`);
      const results = await Promise.all(racers.map((principal) => claimDefaultWorkspace(principal)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const owners = (await listMembers(DEFAULT_WORKSPACE_ID)).filter((member) => member.role === "owner");
      expect(owners).toHaveLength(1);
      expect((await getWorkspace(DEFAULT_WORKSPACE_ID))!.created_by).toBe(owners[0].principal);
      // Later sign-ins claim nothing.
      expect(await claimDefaultWorkspace(`late-${unique()}@example.com`)).toBeNull();
    } finally {
      await db.execute(sql`delete from workspace_members where workspace_id = ${DEFAULT_WORKSPACE_ID}`);
      await db.execute(sql`delete from workspaces where id = ${DEFAULT_WORKSPACE_ID}`);
      for (const row of savedWs) {
        await db.execute(sql`insert into workspaces (id, name, schema_name, created_by, created_at)
          values (${row.id as string}, ${row.name as string}, ${row.schema_name as string}, ${row.created_by as string}, ${row.created_at as string})`);
      }
      for (const row of savedMembers) {
        await db.execute(sql`insert into workspace_members (workspace_id, principal, role, added_by, added_at)
          values (${row.workspace_id as string}, ${row.principal as string}, ${row.role as string}, ${row.added_by as string}, ${row.added_at as string})`);
      }
    }
  });
});

describe("KAN-12: ALLOWED_EMAIL_DOMAINS", () => {
  it("blocks other domains and sign-ins without a verified email", () => {
    const env = { ALLOWED_EMAIL_DOMAINS: " Kernelfood.co , @partner.example " };
    expect(allowedEmailDomains(env)).toEqual(["kernelfood.co", "partner.example"]);
    expect(emailDomainAllowed("a@kernelfood.co", env)).toBe(true);
    expect(emailDomainAllowed("a@partner.example", env)).toBe(true);
    expect(emailDomainAllowed("a@evil.example", env)).toBe(false);
    expect(emailDomainAllowed("a@sub.kernelfood.co", env)).toBe(false);
    expect(emailDomainAllowed(null, env)).toBe(false);
    expect(emailDomainAllowed("a@anything.example", {})).toBe(true);

    vi.stubEnv("ALLOWED_EMAIL_DOMAINS", "kernelfood.co");
    expect(() =>
      loginIdentity({ provider: google, profile: { sub: "1", email: "x@evil.example", email_verified: true } }),
    ).toThrow(/not allowed/);
    expect(() =>
      loginIdentity({ provider: google, profile: { sub: "2", email: "x@kernelfood.co", email_verified: false } }),
    ).toThrow(/verified email/);
    const ok = loginIdentity({ provider: google, profile: { sub: "3", email: "x@kernelfood.co", email_verified: true } });
    expect(ok.email).toBe("x@kernelfood.co");
    expect(ok.subject).toBe("google:3");
  });
});
