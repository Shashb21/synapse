import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KAN-28: no sign-ups. The owner sells a customer seats, assigns them by
 * email, and only a seat holder signs in, with SSO. The IdP is mocked the way
 * tests/kan-11-12-auth-hardening.test.ts does: a stubbed `fetch` answers the
 * token and userinfo calls of a real beginLogin → /api/auth/callback round trip.
 */

/** A request cookie jar the route handlers read and createSession/signOut write. */
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));

import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import { GET as callbackGet } from "@/app/api/auth/callback/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { GET as customersGet, POST as customersPost } from "@/app/api/admin/customers/route";
import { GET as customerGet, PATCH as customerPatch } from "@/app/api/admin/customers/[id]/route";
import { DELETE as seatsDelete, POST as seatsPost } from "@/app/api/admin/customers/[id]/seats/route";
import { deleteAccountsLike } from "@/modules/auth/accounts";
import { ensureAdminAccount } from "@/modules/auth/admin-setup";
import {
  assignSeats,
  createCustomer,
  CustomerError,
  deleteCustomersLike,
  getCustomer,
  hasActiveSeat,
  listSeats,
  MAX_BULK_EMAILS,
  parseDomains,
  parseEmailList,
  unassignSeat,
  updateCustomer,
} from "@/modules/auth/customers";
import { gateFor } from "@/modules/auth/gate";
import {
  currentSession,
  LOGIN_ERROR_MESSAGES,
  loginOptions,
  NO_SEAT_ERROR,
  NO_SEAT_MESSAGE,
  seatAllowsSignIn,
  SESSION_COOKIE,
  withoutClaimedOperator,
} from "@/modules/auth/session";
import { mayClaimDefault } from "@/modules/workspaces/session";

const run = Math.random().toString(36).slice(2, 8);
const DOMAIN = `kan28-${run}.example.test`;
const OTHER_DOMAIN = `kan28-other-${run}.example.test`;
const PREFIX = `KAN-28 ${run}`;
const at = (who: string, domain = DOMAIN) => `${who}@${domain}`;
const ADMIN_PASSWORD = "cobalt-heron-lantern-28";

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function read(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * A full Google sign-in: POST /api/auth/login starts it, the (stubbed) IdP
 * answers, and GET /api/auth/callback finishes it. Returns the callback's
 * redirect and the session cookie it left, if any.
 */
async function ssoSignIn(email: string, options: { verified?: boolean } = {}) {
  jar.values.clear();
  vi.stubEnv("GOOGLE_IDP_CLIENT_ID", "kan28-client");
  const start = await read(await loginPost(jsonRequest("/api/auth/login", "POST", { provider_id: "google" })));
  expect(start.status).toBe(200);
  const pending = JSON.parse(jar.values.get("synapse_oauth_pending")!) as { state: string };
  const sub = `kan28-${email}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("token")
        ? new Response(JSON.stringify({ access_token: "at", id_token: idToken({ sub }) }))
        : new Response(JSON.stringify({ sub, email, email_verified: options.verified ?? true, name: `Person ${email}` })),
    ),
  );
  const response = await callbackGet(
    new Request(`http://localhost/api/auth/callback?code=c&state=${encodeURIComponent(pending.state)}`),
  );
  const location = new URL(response.headers.get("location") ?? "", "http://localhost");
  return { status: response.status, location, cookie: jar.values.get(SESSION_COOKIE) ?? null };
}

async function sessionRowsFor(email: string): Promise<number> {
  const found = (await sharedDb().execute(
    sql`select count(*)::int as n from auth_sessions where email = ${email}`,
  )) as unknown as { n: number }[];
  return Number(found[0]?.n ?? 0);
}

/** Uses a saved session cookie for the next calls. */
function useCookie(cookie: string | null) {
  jar.values.clear();
  if (cookie) jar.values.set(SESSION_COOKIE, cookie);
}

async function customer(name: string, seats: number, domains: string[] = [DOMAIN]) {
  return createCustomer({ name: `${PREFIX} ${name}`, seats, email_domains: domains });
}

async function adminSession(): Promise<string> {
  const email = `kan28-admin-${run}@${DOMAIN}`;
  await ensureAdminAccount({ email, name: "KAN-28 Admin", password: ADMIN_PASSWORD });
  jar.values.clear();
  const res = await passwordLogin(jsonRequest("/api/auth/password/login", "POST", { email, password: ADMIN_PASSWORD }));
  expect(res.status).toBe(200);
  return jar.values.get(SESSION_COOKIE)!;
}

const savedOwners = process.env.OWNER_EMAILS;

beforeEach(() => {
  jar.values.clear();
  process.env.OWNER_EMAILS = "";
  delete process.env.ALLOWED_EMAIL_DOMAINS;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (savedOwners === undefined) delete process.env.OWNER_EMAILS;
  else process.env.OWNER_EMAILS = savedOwners;
  await deleteCustomersLike(`${PREFIX} %`);
  await deleteAccountsLike(`kan28-%-${run}@%`);
  await sharedDb().execute(sql`delete from auth_sessions where email like ${`%@${DOMAIN}`} or email like ${`%@${OTHER_DOMAIN}`}`);
});

describe("KAN-28: no self sign-up", () => {
  it("has no /signup page or sign-up API, no ALLOW_SIGNUP and no sign-up link", () => {
    const root = process.cwd();
    expect(existsSync(join(root, "src/app/signup"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/auth/password/signup"))).toBe(false);
    expect(existsSync(join(root, "src/modules/auth/signup-policy.ts"))).toBe(false);
    expect(existsSync(join(root, "src/components/workspaces/signup-panel.tsx"))).toBe(false);
    expect(loginOptions()).not.toHaveProperty("signup");
    // /signup is no longer a public page: it is an ordinary gated path that 404s.
    expect(gateFor("/signup")).not.toBe("open");
    const panel = readFileSync(join(root, "src/components/workspaces/login-panel.tsx"), "utf8");
    expect(panel).not.toMatch(/\/signup|Create an account/);
    expect(readFileSync(join(root, ".env.example"), "utf8")).not.toMatch(/ALLOW_SIGNUP/);
    expect(readFileSync(join(root, "docs/deploy-checklist.md"), "utf8")).not.toMatch(/ALLOW_SIGNUP|\/signup/);
  });

  it("the /login no-seat message is a fixed code, not text from the URL", () => {
    expect(NO_SEAT_ERROR).toBe("no_seat");
    expect(LOGIN_ERROR_MESSAGES[NO_SEAT_ERROR]).toBe(
      "Your organisation hasn't assigned you a Synapse seat. Ask your administrator.",
    );
    expect(NO_SEAT_MESSAGE).toBe(LOGIN_ERROR_MESSAGES.no_seat);
  });
});

describe("KAN-28: SSO sign-in needs a seat", () => {
  it("a verified email with a seat on an active customer gets a session", async () => {
    const acme = await customer("Acme", 2);
    await assignSeats({ customer_id: acme.id, emails: [at("ana").toUpperCase()], by: "test" });
    const result = await ssoSignIn(at("ana"));
    expect(result.status).toBe(307);
    expect(result.location.pathname).toBe("/workspaces");
    expect(result.cookie).toBeTruthy();
    const session = await currentSession();
    expect(session).toMatchObject({ provider_id: "google", email: at("ana") });
    // A seat holder never claims the Default workspace.
    expect(mayClaimDefault(session!)).toBe(false);
  });

  it("without a seat: no session, and /login?error=no_seat with nothing else", async () => {
    const result = await ssoSignIn(at("nobody"));
    expect(result.location.pathname).toBe("/login");
    expect([...result.location.searchParams.keys()]).toEqual(["error"]);
    expect(result.location.searchParams.get("error")).toBe("no_seat");
    expect(result.cookie).toBeNull();
    expect(await sessionRowsFor(at("nobody"))).toBe(0);
  });

  it("an unverified email is refused even when that address holds a seat", async () => {
    const acme = await customer("Unverified", 1);
    await assignSeats({ customer_id: acme.id, emails: [at("unv")], by: "test" });
    const result = await ssoSignIn(at("unv"), { verified: false });
    expect(result.location.searchParams.get("error")).toBe("no_seat");
    expect(result.cookie).toBeNull();
  });

  it("a deactivated customer: sign-in refused, and deactivating ends live sessions at once", async () => {
    const beta = await customer("Beta", 2);
    await assignSeats({ customer_id: beta.id, emails: [at("bo"), at("bea")], by: "test" });
    const bo = await ssoSignIn(at("bo"));
    expect(bo.cookie).toBeTruthy();
    expect(await sessionRowsFor(at("bo"))).toBe(1);

    await updateCustomer(beta.id, { active: false });
    expect(await sessionRowsFor(at("bo"))).toBe(0);
    useCookie(bo.cookie);
    expect(await currentSession()).toBeNull();

    const bea = await ssoSignIn(at("bea"));
    expect(bea.location.searchParams.get("error")).toBe("no_seat");
    expect(bea.cookie).toBeNull();

    // Reactivating lets them back in.
    await updateCustomer(beta.id, { active: true });
    expect((await ssoSignIn(at("bea"))).cookie).toBeTruthy();
  });

  it("unassigning a seat ends that person's sessions, and they can't sign back in", async () => {
    const gamma = await customer("Gamma", 2);
    await assignSeats({ customer_id: gamma.id, emails: [at("gil"), at("gus")], by: "test" });
    const gil = await ssoSignIn(at("gil"));
    const gus = await ssoSignIn(at("gus"));
    await unassignSeat({ customer_id: gamma.id, email: at("GIL") });
    expect(await sessionRowsFor(at("gil"))).toBe(0);
    useCookie(gil.cookie);
    expect(await currentSession()).toBeNull();
    // Someone else's seat is untouched.
    useCookie(gus.cookie);
    expect((await currentSession())?.email).toBe(at("gus"));
    expect((await ssoSignIn(at("gil"))).location.searchParams.get("error")).toBe("no_seat");
    expect((await getCustomer(gamma.id))?.seats_used).toBe(1);
  });

  it("currentSession re-checks the seat, so a session row that outlived its seat stops working", async () => {
    const delta = await customer("Delta", 1);
    await assignSeats({ customer_id: delta.id, emails: [at("dee")], by: "test" });
    const dee = await ssoSignIn(at("dee"));
    // Remove the seat behind the store's back: the session row survives, the session does not.
    await sharedDb().execute(sql`delete from seat_assignments where email = ${at("dee")}`);
    expect(await sessionRowsFor(at("dee"))).toBe(1);
    useCookie(dee.cookie);
    expect(await currentSession()).toBeNull();
    expect(await sessionRowsFor(at("dee"))).toBe(0);
  });

  it("platform admins bypass the seat check: OWNER_EMAILS and enabled admin accounts; demo sessions are untouched", async () => {
    process.env.OWNER_EMAILS = at("boss", OTHER_DOMAIN);
    const boss = await ssoSignIn(at("boss", OTHER_DOMAIN));
    expect(boss.cookie).toBeTruthy();
    expect((await currentSession())?.email).toBe(at("boss", OTHER_DOMAIN));

    const adminEmail = `kan28-sso-admin-${run}@${OTHER_DOMAIN}`;
    await ensureAdminAccount({ email: adminEmail, password: ADMIN_PASSWORD });
    expect(await hasActiveSeat(adminEmail)).toBe(false);
    expect(await seatAllowsSignIn(adminEmail)).toBe(true);
    expect((await ssoSignIn(adminEmail)).cookie).toBeTruthy();

    // The admin's password sign-in needs no seat either.
    const cookie = await adminSession();
    useCookie(cookie);
    expect((await currentSession())?.provider_id).toBe("password");

    // Demo sign-in (development only) is unchanged.
    jar.values.clear();
    const demo = await loginPost(jsonRequest("/api/auth/login", "POST", { demo: true, actor_name: `Demo ${run}` }));
    expect(demo.status).toBe(200);
    expect((await currentSession())?.provider_id).toBe("demo");
  });
});

describe("KAN-28: a customer's IdP can't make a seat holder the platform owner", () => {
  it("a claimed operator role is dropped for a seat holder, kept for OWNER_EMAILS", async () => {
    const base = {
      provider_id: "microsoft",
      subject: "microsoft:x",
      actor_name: "Claimer",
      actor_function: "heor" as const,
      role: "operator" as const,
    };
    expect((await withoutClaimedOperator({ ...base, email: at("claimer") })).role).toBe("contributor");
    expect((await withoutClaimedOperator({ ...base, email: null })).role).toBe("contributor");
    process.env.OWNER_EMAILS = at("owner");
    expect((await withoutClaimedOperator({ ...base, email: at("owner") })).role).toBe("operator");
    expect((await withoutClaimedOperator({ ...base, role: "viewer", email: at("claimer") })).role).toBe("viewer");
  });
});

describe("KAN-28: seats", () => {
  it("assigned seats can't exceed seats sold", async () => {
    const eps = await customer("Epsilon", 2);
    await assignSeats({ customer_id: eps.id, emails: [at("e1")], by: "test" });
    await assignSeats({ customer_id: eps.id, emails: [at("e2")], by: "test" });
    const third = assignSeats({ customer_id: eps.id, emails: [at("e3")], by: "test" });
    await expect(third).rejects.toMatchObject({ code: "seat_limit" });
    await expect(assignSeats({ customer_id: eps.id, emails: [at("e3")], by: "test" })).rejects.toThrow(
      /0 seats remaining \(2 of 2 assigned\)/,
    );
    // Re-assigning someone who already has a seat is a no-op, not a new seat.
    const again = await assignSeats({ customer_id: eps.id, emails: [at("e1")], by: "test" });
    expect(again).toMatchObject({ assigned: [], already: [at("e1")] });
    expect((await getCustomer(eps.id))?.seats_used).toBe(2);
  });

  it("concurrent assignments can't overshoot the limit", async () => {
    const race = await customer("Race", 2);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => assignSeats({ customer_id: race.id, emails: [at(`race${i}`)], by: "test" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await listSeats(race.id)).toHaveLength(2);
  });

  it("a bulk paste is all or nothing, and says how many seats remain", async () => {
    const zeta = await customer("Zeta", 3);
    await assignSeats({ customer_id: zeta.id, emails: [at("z1")], by: "test" });
    const paste = `${at("z2")}, ${at("z3")}\n${at("z4")}`;
    await expect(assignSeats({ customer_id: zeta.id, emails: paste, by: "test" })).rejects.toThrow(
      /2 seats remaining .* 3 new emails can't be assigned\. Nothing was assigned/,
    );
    expect((await listSeats(zeta.id)).map((s) => s.email)).toEqual([at("z1")]);

    const fits = await assignSeats({ customer_id: zeta.id, emails: `Zed <${at("Z2")}>; ${at("z1")} ${at("z3")}`, by: "ops" });
    expect(fits.assigned.sort()).toEqual([at("z2"), at("z3")]);
    expect(fits.already).toEqual([at("z1")]);
    expect(fits.customer).toMatchObject({ seats: 3, seats_used: 3 });

    expect(parseEmailList(`a@x.co,,A@X.CO\n b@x.co`)).toEqual(["a@x.co", "b@x.co"]);
    const many = Array.from({ length: MAX_BULK_EMAILS + 1 }, (_, i) => at(`m${i}`));
    await expect(assignSeats({ customer_id: zeta.id, emails: many, by: "test" })).rejects.toThrow(/at most/);
    await expect(assignSeats({ customer_id: zeta.id, emails: "not-an-email", by: "test" })).rejects.toThrow(/valid email/);
  });

  it("lowering seats below the number assigned is refused with a clear message", async () => {
    const eta = await customer("Eta", 3);
    await assignSeats({ customer_id: eta.id, emails: [at("h1"), at("h2")], by: "test" });
    await expect(updateCustomer(eta.id, { seats: 1 })).rejects.toThrow(
      /has 2 seats assigned, so seats can't go below 2\. Unassign 1 seat first/,
    );
    expect((await getCustomer(eta.id))?.seats).toBe(3);
    expect((await updateCustomer(eta.id, { seats: 2 })).seats).toBe(2);
    await expect(updateCustomer(eta.id, { seats: -1 })).rejects.toThrow(/whole number/);
    await expect(updateCustomer(eta.id, { seats: 1.5 })).rejects.toThrow(/whole number/);
  });

  it("an email must match one of the customer's domains, when domains are set", async () => {
    const theta = await customer("Theta", 5, [DOMAIN]);
    await expect(
      assignSeats({ customer_id: theta.id, emails: [at("t1"), at("stray", OTHER_DOMAIN)], by: "test" }),
    ).rejects.toThrow(/is not on .*Theta's email domains/);
    expect(await listSeats(theta.id)).toHaveLength(0);
    // Subdomains don't count as the domain.
    await expect(assignSeats({ customer_id: theta.id, emails: [at("t1", `eu.${DOMAIN}`)], by: "test" })).rejects.toThrow(
      /email domains/,
    );

    await assignSeats({ customer_id: theta.id, emails: [at("t1")], by: "test" });
    await expect(updateCustomer(theta.id, { email_domains: [OTHER_DOMAIN] })).rejects.toThrow(/outside these domains/);

    // No domains: any domain may hold a seat.
    const open = await customer("Open", 1, []);
    await assignSeats({ customer_id: open.id, emails: [at("any", OTHER_DOMAIN)], by: "test" });
    expect(parseDomains(" @Acme.com, acme.eu acme.com")).toEqual(["acme.com", "acme.eu"]);
    expect(() => parseDomains("not a domain!")).toThrow(CustomerError);
  });

  it("one email can't hold seats at two customers", async () => {
    const iota = await customer("Iota", 2);
    const kappa = await customer("Kappa", 2);
    await assignSeats({ customer_id: iota.id, emails: [at("shared")], by: "test" });
    await expect(assignSeats({ customer_id: kappa.id, emails: [at("SHARED")], by: "test" })).rejects.toMatchObject({
      code: "taken",
    });
    expect(await listSeats(kappa.id)).toHaveLength(0);
    // The database enforces it too.
    await expect(
      sharedDb().execute(sql`
        insert into seat_assignments (customer_id, email, assigned_by, assigned_at)
        values (${kappa.id}, ${at("shared")}, 'test', 'now')`),
    ).rejects.toThrow();
  });
});

describe("KAN-28: /api/admin/customers", () => {
  it("the owner lists, creates, edits, assigns (with limit messages) and unassigns", async () => {
    useCookie(await adminSession());
    const created = await read(
      await customersPost(jsonRequest("/api/admin/customers", "POST", { name: `${PREFIX} Api`, email_domains: DOMAIN, seats: 2 })),
    );
    expect(created.status).toBe(201);
    const id = (created.body.customer as { id: string }).id;
    expect(created.body.customer).toMatchObject({ seats: 2, seats_used: 0, active: true, email_domains: [DOMAIN] });

    const listed = await read(await customersGet());
    expect(listed.status).toBe(200);
    expect((listed.body.customers as { id: string }[]).some((c) => c.id === id)).toBe(true);

    const assigned = await read(
      await seatsPost(jsonRequest(`/api/admin/customers/${id}/seats`, "POST", { emails: `${at("api1")}\n${at("api2")}` }), ctx(id)),
    );
    expect(assigned.status).toBe(200);
    expect(assigned.body.customer).toMatchObject({ seats_used: 2 });
    expect((assigned.body.seats as { assigned_by: string }[])[0].assigned_by).toBe(`kan28-admin-${run}@${DOMAIN}`);

    const over = await read(
      await seatsPost(jsonRequest(`/api/admin/customers/${id}/seats`, "POST", { emails: [at("api3")] }), ctx(id)),
    );
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("seat_limit");
    expect(String(over.body.error)).toMatch(/0 seats remaining/);

    const lower = await read(await customerPatch(jsonRequest(`/api/admin/customers/${id}`, "PATCH", { seats: 1 }), ctx(id)));
    expect(lower.status).toBe(409);
    expect(String(lower.body.error)).toMatch(/can't go below 2/);

    const offDomain = await read(
      await seatsPost(jsonRequest(`/api/admin/customers/${id}/seats`, "POST", { emails: [at("x", OTHER_DOMAIN)] }), ctx(id)),
    );
    expect(offDomain.status).toBe(400);

    const edited = await read(
      await customerPatch(jsonRequest(`/api/admin/customers/${id}`, "PATCH", { name: `${PREFIX} Api Renamed`, seats: 3 }), ctx(id)),
    );
    expect(edited.body.customer).toMatchObject({ name: `${PREFIX} Api Renamed`, seats: 3, seats_used: 2 });

    const removed = await read(
      await seatsDelete(jsonRequest(`/api/admin/customers/${id}/seats`, "DELETE", { email: at("api1") }), ctx(id)),
    );
    expect(removed.status).toBe(200);
    expect(removed.body.customer).toMatchObject({ seats_used: 1 });
    const detail = await read(await customerGet(jsonRequest(`/api/admin/customers/${id}`, "GET"), ctx(id)));
    expect((detail.body.seats as { email: string }[]).map((s) => s.email)).toEqual([at("api2")]);

    expect((await customerGet(jsonRequest("/x", "GET"), ctx("cust_missing"))).status).toBe(404);
    expect((await seatsDelete(jsonRequest("/x", "DELETE", { email: at("api1") }), ctx(id))).status).toBe(404);
    expect((await customersPost(jsonRequest("/x", "POST", { name: "" }))).status).toBe(400);
  });

  it("non-owners get 403 on every /api/admin/customers handler", async () => {
    const lam = await customer("Lambda", 1);
    await assignSeats({ customer_id: lam.id, emails: [at("seat-holder")], by: "test" });
    const holder = await ssoSignIn(at("seat-holder"));
    expect(holder.cookie).toBeTruthy();
    vi.stubEnv("GOOGLE_IDP_CLIENT_ID", "kan28-client");

    const calls = async () => [
      await customersGet(),
      await customersPost(jsonRequest("/x", "POST", { name: `${PREFIX} Sneaky`, seats: 99 })),
      await customerGet(jsonRequest("/x", "GET"), ctx(lam.id)),
      await customerPatch(jsonRequest("/x", "PATCH", { seats: 99 }), ctx(lam.id)),
      await seatsPost(jsonRequest("/x", "POST", { emails: [at("friend")] }), ctx(lam.id)),
      await seatsDelete(jsonRequest("/x", "DELETE", { email: at("seat-holder") }), ctx(lam.id)),
    ];
    // A signed-in seat holder (SSO, not an owner).
    useCookie(holder.cookie);
    expect((await currentSession())?.email).toBe(at("seat-holder"));
    for (const response of await calls()) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("owner_only");
    }
    // Signed out, with an identity provider configured.
    useCookie(null);
    for (const response of await calls()) expect(response.status).toBe(403);

    const after = await getCustomer(lam.id);
    expect(after).toMatchObject({ seats: 1, seats_used: 1 });
  });
});
