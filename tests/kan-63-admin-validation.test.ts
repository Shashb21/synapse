import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KAN-63: admin audit fixes. Route parameters and fallbacks are validated,
 * S0 has no route, customers and users can be deleted (owner only, ending
 * their sessions), customer names are unique ignoring case, `active` must be
 * a real boolean, and every SDLC spec has a raw route on /admin/docs.
 * Sessions use the cookie jar of tests/kan-28-seats-sso.test.ts.
 */

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers(),
}));

import "@/modules";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import { POST as controlPost } from "@/app/api/control/route";
import { POST as customersPost } from "@/app/api/admin/customers/route";
import { DELETE as customerDelete, PATCH as customerPatch } from "@/app/api/admin/customers/[id]/route";
import { POST as usersPost } from "@/app/api/admin/users/route";
import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { GET as docGet } from "@/app/admin/docs/sdlc/[slug]/route";
import {
  createAccount,
  deleteAccount,
  deleteAccountsLike,
  getAccount,
  type Account,
} from "@/modules/auth/accounts";
import { ensureAdminAccount } from "@/modules/auth/admin-setup";
import {
  assignSeats,
  createCustomer,
  deleteCustomersLike,
  getCustomer,
  listSeats,
  updateCustomer,
} from "@/modules/auth/customers";
import { TEST_AS_CUSTOMER_COOKIE } from "@/modules/auth/owner";
import { createSession, currentSession, SESSION_COOKIE } from "@/modules/auth/session";
import {
  parseFallbacks,
  parseRouteParam,
  routeConfig,
  setRouteConfig,
  stageHasRoute,
  type RouteConfig,
} from "@/modules/kernel/routing";
import { AI_OFF_MESSAGE } from "@/modules/kernel/ai-switch";
import { AI_OFF_OWNER_MESSAGE } from "@/components/platform/control-panel-view";
import { SDLC_DOCS, SPEC_DOCS } from "@/components/admin/sdlc-docs";
import { formatUtc } from "@/lib/format-time";

const run = Math.random().toString(36).slice(2, 8);
const DOMAIN = `kan63-${run}.example.test`;
const PREFIX = `KAN-63 ${run}`;
const PASSWORD = "amber-falcon-ledger-63";
const at = (who: string) => `kan63-${who}-${run}@${DOMAIN}`;

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
const control = async (body: Record<string, unknown>) => read(await controlPost(jsonRequest("/api/control", "POST", body)));

async function login(email: string): Promise<string> {
  jar.values.clear();
  const res = await passwordLogin(jsonRequest("/api/auth/password/login", "POST", { email, password: PASSWORD }));
  expect(res.status).toBe(200);
  return jar.values.get(SESSION_COOKIE)!;
}

function useCookie(cookie: string | null) {
  jar.values.clear();
  if (cookie) jar.values.set(SESSION_COOKIE, cookie);
}

/** A signed-in admin's password session (an owner). */
async function adminSession(who = "admin"): Promise<{ cookie: string; account: Account }> {
  const { account } = await ensureAdminAccount({ email: at(who), name: `KAN-63 ${who}`, password: PASSWORD });
  return { cookie: await login(at(who)), account };
}

/** A not-owner caller: the test owner bypass is switched off for this request. */
function asCustomer() {
  jar.values.clear();
  jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
}

async function sessionRows(where: ReturnType<typeof sql>): Promise<number> {
  const found = (await sharedDb().execute(sql`select count(*)::int as n from auth_sessions where ${where}`)) as unknown as {
    n: number;
  }[];
  return Number(found[0]?.n ?? 0);
}

const savedOwners = process.env.OWNER_EMAILS;
let savedS9: RouteConfig;

beforeEach(() => {
  jar.values.clear();
  process.env.OWNER_EMAILS = "";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (savedOwners === undefined) delete process.env.OWNER_EMAILS;
  else process.env.OWNER_EMAILS = savedOwners;
  if (savedS9) {
    await setRouteConfig({
      stage: "S9",
      provider_id: savedS9.provider_id,
      model: savedS9.model,
      temperature: savedS9.params.temperature,
      max_tokens: savedS9.params.max_tokens,
      fallbacks: savedS9.fallbacks,
      actor_name: "test",
    });
  }
  await deleteCustomersLike(`${PREFIX} %`);
  await deleteAccountsLike(`kan63-%-${run}@%`);
  await sharedDb().execute(sql`delete from auth_sessions where email like ${`%@${DOMAIN}`}`);
});

describe("KAN-63: set_route validates its numbers", () => {
  it("refuses out-of-range and non-numeric temperature and max_tokens with 400, saving nothing", async () => {
    savedS9 = await routeConfig("S9");
    const base = { action: "set_route", stage: "S9", provider_id: "xai-grok", model: "grok-4" };
    for (const max_tokens of [-5, -100, 0, 99.5, 99_999_999_999, "abc", "12abc", true]) {
      const res = await control({ ...base, max_tokens });
      expect(res.status, `max_tokens ${String(max_tokens)}`).toBe(400);
      expect(String(res.body.error)).toMatch(/Max tokens must be a whole number from 1 to 200,000/);
    }
    for (const temperature of [-1, 2.5, 99, "abc", "1e400"]) {
      const res = await control({ ...base, temperature });
      expect(res.status, `temperature ${String(temperature)}`).toBe(400);
      expect(String(res.body.error)).toMatch(/Temperature must be a number from 0 to 2/);
    }
    expect(await routeConfig("S9")).toEqual(savedS9);
  });

  it("accepts numbers and numeric strings in range; a blank field keeps the current value, never 0", async () => {
    const base = { action: "set_route", stage: "S9", provider_id: "xai-grok", model: "grok-4" };
    const saved = await control({ ...base, temperature: "0.4", max_tokens: 4096, fallbacks: "anthropic-claude" });
    expect(saved.status).toBe(200);
    expect((await routeConfig("S9")).params).toEqual({ temperature: 0.4, max_tokens: 4096 });

    expect((await control({ ...base, temperature: "", max_tokens: "  " })).status).toBe(200);
    expect((await routeConfig("S9")).params).toEqual({ temperature: 0.4, max_tokens: 4096 });
    expect((await control({ ...base, temperature: null })).status).toBe(200);
    expect((await routeConfig("S9")).params).toEqual({ temperature: 0.4, max_tokens: 4096 });

    expect((await control({ ...base, temperature: 2, max_tokens: "200000" })).status).toBe(200);
    expect((await routeConfig("S9")).params).toEqual({ temperature: 2, max_tokens: 200_000 });
  });

  it("parseRouteParam is the one rule", () => {
    expect(parseRouteParam("", "max_tokens")).toBeUndefined();
    expect(parseRouteParam(undefined, "temperature")).toBeUndefined();
    expect(parseRouteParam(" 8192 ", "max_tokens")).toBe(8192);
    expect(parseRouteParam(0, "temperature")).toBe(0);
    expect(() => parseRouteParam(0, "max_tokens")).toThrow(/whole number/);
  });
});

describe("KAN-63: set_route validates fallbacks", () => {
  const base = { action: "set_route", stage: "S9", provider_id: "xai-grok", model: "grok-4" };

  it("refuses an unknown provider and the stage's own provider", async () => {
    const before = await routeConfig("S9");
    const unknown = await control({ ...base, fallbacks: "anthropic-claude, nope-ai" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("Unknown fallback provider nope-ai");
    const self = await control({ ...base, fallbacks: ["xai-grok"] });
    expect(self.status).toBe(400);
    expect(String(self.body.error)).toMatch(/xai-grok is this stage's provider/);
    expect((await control({ ...base, fallbacks: 42 })).status).toBe(400);
    expect(await routeConfig("S9")).toEqual(before);
  });

  it("drops repeats, and an empty field means no fallbacks (not the defaults)", async () => {
    const deduped = await control({ ...base, fallbacks: "openai, anthropic-claude, openai,  ,anthropic-claude" });
    expect(deduped.status).toBe(200);
    expect((await routeConfig("S9")).fallbacks).toEqual(["openai", "anthropic-claude"]);

    expect((await control({ ...base, fallbacks: "" })).status).toBe(200);
    expect((await routeConfig("S9")).fallbacks).toEqual([]);
    expect((await control({ ...base, fallbacks: "openai" })).status).toBe(200);
    expect((await control({ ...base, fallbacks: [] })).status).toBe(200);
    expect((await routeConfig("S9")).fallbacks).toEqual([]);

    // Leaving fallbacks out keeps the chain, minus a new provider that can't fall back to itself.
    expect((await control({ ...base, fallbacks: "openai, anthropic-claude" })).status).toBe(200);
    expect((await control({ ...base, provider_id: "openai", model: "" })).status).toBe(200);
    expect(await routeConfig("S9")).toMatchObject({ provider_id: "openai", fallbacks: ["anthropic-claude"] });
    expect(parseFallbacks(undefined, "openai")).toBeUndefined();
  });
});

describe("KAN-63: routes only for stages that call a model", () => {
  it("refuses set_route on mechanical S0 (and other model-free stages) with 400", async () => {
    expect(stageHasRoute("S0")).toBe(false);
    expect(stageHasRoute("S2")).toBe(true);
    for (const stage of ["S0", "S1", "S5"]) {
      const res = await control({ action: "set_route", stage, provider_id: "xai-grok", model: "grok-4" });
      expect(res.status, stage).toBe(400);
      expect(String(res.body.error)).toMatch(new RegExp(`${stage} does not call a model`));
    }
  });

  it("connect_provider no longer exists: provider OAuth was removed (KAN-65)", async () => {
    const res = await control({ action: "connect_provider", provider_id: "nope-ai" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown action connect_provider");
  });

  it("the control panel's AI-off copy is for the owner, not the customer", () => {
    expect(AI_OFF_OWNER_MESSAGE).toBe("AI is off platform-wide. Turn it on above.");
    expect(AI_OFF_MESSAGE).toMatch(/contact your Synapse administrator/);
    // KAN-68: the customer is not told AI is off, nor sent to a workspace owner with no switch.
    expect(AI_OFF_MESSAGE).not.toMatch(/\bAI\b|workspace owner/);
    const view = readFileSync(join(process.cwd(), "src/components/platform/control-panel-view.tsx"), "utf8");
    expect(view).toMatch(/!ai\.enabled\s*\?\s*AI_OFF_OWNER_MESSAGE/);
  });
});

describe("KAN-63: customers", () => {
  it("accepts only a real boolean for active, on create and on update", async () => {
    const { cookie } = await adminSession();
    useCookie(cookie);
    for (const active of ["true", "false", 1, null]) {
      const res = await read(
        await customersPost(jsonRequest("/api/admin/customers", "POST", { name: `${PREFIX} Str ${String(active)}`, active })),
      );
      expect(res.status, String(active)).toBe(400);
      expect(res.body.error).toBe("active must be true or false.");
    }
    const made = await createCustomer({ name: `${PREFIX} Bool`, active: true });
    const patched = await read(await customerPatch(jsonRequest("/x", "PATCH", { active: "true" }), ctx(made.id)));
    expect(patched.status).toBe(400);
    expect((await getCustomer(made.id))?.active).toBe(true);
    expect((await updateCustomer(made.id, { active: false })).active).toBe(false);
  });

  it("refuses a duplicate name ignoring case, on create and on rename (409)", async () => {
    const { cookie } = await adminSession();
    useCookie(cookie);
    const first = await createCustomer({ name: `${PREFIX} Velmara` });
    const dupe = await read(
      await customersPost(jsonRequest("/api/admin/customers", "POST", { name: `  ${PREFIX} VELMARA ` })),
    );
    expect(dupe.status).toBe(409);
    expect(String(dupe.body.error)).toMatch(/already exists/);

    const second = await createCustomer({ name: `${PREFIX} Other` });
    const rename = await read(
      await customerPatch(jsonRequest("/x", "PATCH", { name: `${PREFIX} velmara` }), ctx(second.id)),
    );
    expect(rename.status).toBe(409);
    expect((await getCustomer(second.id))?.name).toBe(`${PREFIX} Other`);
    // Changing only the case of its own name is fine.
    const recased = await read(await customerPatch(jsonRequest("/x", "PATCH", { name: `${PREFIX} VELMARA` }), ctx(first.id)));
    expect(recased.status).toBe(200);
  });

  it("delete removes the customer and its seats and ends seat holders' sessions at once", async () => {
    const doomed = await createCustomer({ name: `${PREFIX} Doomed`, seats: 2, email_domains: [DOMAIN] });
    await assignSeats({ customer_id: doomed.id, emails: [at("seat1"), at("seat2")], by: "test" });
    // A live SSO session for a seat holder.
    jar.values.clear();
    await createSession({
      provider_id: "google",
      subject: `kan63-${run}`,
      email: at("seat1"),
      actor_name: "Seat One",
      actor_function: "medical_affairs",
      role: "contributor",
    });
    const seatCookie = jar.values.get(SESSION_COOKIE)!;
    expect((await currentSession())?.email).toBe(at("seat1"));

    const { cookie } = await adminSession();
    useCookie(cookie);
    const res = await read(await customerDelete(jsonRequest("/x", "DELETE"), ctx(doomed.id)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, seats_removed: 2 });
    expect(await getCustomer(doomed.id)).toBeNull();
    expect(await listSeats(doomed.id)).toEqual([]);
    expect(await sessionRows(sql`email = ${at("seat1")}`)).toBe(0);
    useCookie(seatCookie);
    expect(await currentSession()).toBeNull();

    useCookie(cookie);
    expect((await customerDelete(jsonRequest("/x", "DELETE"), ctx(doomed.id))).status).toBe(404);
  });

  it("only the owner may delete a customer", async () => {
    const kept = await createCustomer({ name: `${PREFIX} Kept` });
    asCustomer();
    const res = await customerDelete(jsonRequest("/x", "DELETE"), ctx(kept.id));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("owner_only");
    expect(await getCustomer(kept.id)).not.toBeNull();
  });
});

describe("KAN-63: users", () => {
  const call = async (body: Record<string, unknown>) => read(await usersPost(jsonRequest("/api/admin/users", "POST", body)));

  it("a blank name on create speaks about the user, not 'your name'", async () => {
    const { cookie } = await adminSession();
    useCookie(cookie);
    for (const name of ["", "   ", undefined]) {
      const res = await call({ action: "create", email: at("noname"), name });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Enter the user's name.");
    }
  });

  it("delete removes the account and ends its sessions; not yourself", async () => {
    const target = await createAccount({
      email: at("target"),
      name: "Target",
      password: PASSWORD,
      role: "operator",
      email_verified: true,
      created_by: "test",
    });
    const targetCookie = await login(at("target"));
    const { cookie, account: admin } = await adminSession();
    useCookie(cookie);

    const self = await call({ action: "delete", id: admin.id });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("You can't delete your own account.");
    expect(await getAccount(admin.id)).not.toBeNull();

    const gone = await call({ action: "delete", id: target.id });
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ deleted: true, user: { id: target.id } });
    expect(await getAccount(target.id)).toBeNull();
    expect(await sessionRows(sql`subject = ${target.id}`)).toBe(0);
    useCookie(targetCookie);
    expect(await currentSession()).toBeNull();

    useCookie(cookie);
    expect((await call({ action: "delete", id: target.id })).status).toBe(404);
  });

  it("the last enabled admin can't be deleted", async () => {
    const { account: lone } = await ensureAdminAccount({ email: at("lone"), name: "Lone", password: PASSWORD });
    // Disable every other enabled admin for the check, then put them back.
    const others = ((await sharedDb().execute(
      sql`update user_accounts set disabled = true where is_admin and not disabled and id <> ${lone.id} returning id`,
    )) as unknown as { id: string }[]).map((row) => row.id);
    try {
      await expect(deleteAccount(lone.id)).rejects.toThrow(/last enabled admin/);
      expect(await getAccount(lone.id)).not.toBeNull();
    } finally {
      for (const id of others) await sharedDb().execute(sql`update user_accounts set disabled = false where id = ${id}`);
    }
    // With another enabled admin it goes.
    await ensureAdminAccount({ email: at("second"), name: "Second", password: PASSWORD });
    await deleteAccount(lone.id);
    expect(await getAccount(lone.id)).toBeNull();
  });

  it("only the owner may delete a user", async () => {
    const kept = await createAccount({
      email: at("kept"),
      name: "Kept",
      password: PASSWORD,
      role: "operator",
      created_by: "test",
    });
    asCustomer();
    const res = await usersPost(jsonRequest("/api/admin/users", "POST", { action: "delete", id: kept.id }));
    expect(res.status).toBe(403);
    expect(await getAccount(kept.id)).not.toBeNull();
  });

  it("the Users page hides Reset password on your own row and shows times with their zone", () => {
    const source = readFileSync(join(process.cwd(), "src/components/admin/admin-users.tsx"), "utf8");
    expect(source).toMatch(/\{!self \? \(\s*<Button[\s\S]*?Reset password/);
    expect(formatUtc("2026-10-02T14:05:00.000Z")).toBe("2 Oct 2026, 14:05 UTC");
    expect(formatUtc(null)).toBe("never");
  });
});

describe("KAN-63: spec documents", () => {
  it("every spec on /admin/sdlc has a raw route on /admin/docs", async () => {
    expect(SDLC_DOCS).toContain("iegp-model.md");
    expect(SDLC_DOCS).toContain("problem-and-solution.md");
    for (const { slug, rel, retired } of SPEC_DOCS) {
      const res = await docGet(jsonRequest(`/admin/docs/sdlc/${slug}`, "GET"), { params: Promise.resolve({ slug }) });
      expect(res.status, slug).toBe(200);
      const body = await res.text();
      expect(body).toBe(readFileSync(join(process.cwd(), rel), "utf8"));
      // The Retired marker follows each file's own "Retired — v1" banner.
      expect(/^> \*\*Retired/m.test(body), slug).toBe(retired);
    }
  });

  it("keeps the 404 for unknown slugs and path traversal", async () => {
    for (const slug of ["nope.md", "../package.json", "..%2F..%2Fpackage.json", "../../.env", "sdlc/01-requirements.md"]) {
      const res = await docGet(jsonRequest("/admin/docs/sdlc/x", "GET"), { params: Promise.resolve({ slug }) });
      expect(res.status, slug).toBe(404);
    }
  });
});
