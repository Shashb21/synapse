import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KAN-88: owner-console changes (users, customers, seats, own password) and
 * sign-in events land in the audit log with who, before and after. Passwords
 * never do. Sessions use the cookie jar of tests/kan-63-admin-validation.test.ts.
 * The audit log is append-only, so every assertion is scoped by this run's ids.
 */

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
  headers: async () => new Headers({ "x-request-id": "kan88-request-0001", "user-agent": "vitest" }),
}));

import "@/modules";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { POST as usersPost } from "@/app/api/admin/users/route";
import { POST as customersPost } from "@/app/api/admin/customers/route";
import { DELETE as customerDelete, PATCH as customerPatch } from "@/app/api/admin/customers/[id]/route";
import { DELETE as seatDelete, POST as seatPost } from "@/app/api/admin/customers/[id]/seats/route";
import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { POST as changePassword } from "@/app/api/account/password/route";
import { GET as auditGet } from "@/app/api/admin/audit/route";
import AuditPage from "@/app/admin/audit/page";
import { deleteAccountsLike, findAccountByEmail, updateAccount } from "@/modules/auth/accounts";
import { ensureAdminAccount, ensureTestCustomer } from "@/modules/auth/admin-setup";
import { deleteCustomersLike, updateCustomer } from "@/modules/auth/customers";
import { TEST_AS_CUSTOMER_COOKIE } from "@/modules/auth/owner";
import { SESSION_COOKIE } from "@/modules/auth/session";
import { listAuditEvents, type AuditEvent } from "@/modules/kernel/audit";

const run = Math.random().toString(36).slice(2, 8);
const DOMAIN = `kan88-${run}.example.test`;
const PREFIX = `KAN-88 ${run}`;
const PASSWORD = "amber-falcon-ledger-88";
const at = (who: string) => `kan88-${who}-${run}@${DOMAIN}`;

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

async function login(email: string, password = PASSWORD) {
  jar.values.clear();
  return passwordLogin(jsonRequest("/api/auth/password/login", "POST", { email, password }));
}

async function signInAdmin(): Promise<string> {
  await ensureAdminAccount({ email: at("admin"), name: "KAN-88 Admin", password: PASSWORD });
  const res = await login(at("admin"));
  expect(res.status).toBe(200);
  return jar.values.get(SESSION_COOKIE)!;
}

function withCookie(cookie: string) {
  jar.values.clear();
  jar.values.set(SESSION_COOKIE, cookie);
}

async function events(filter: Parameters<typeof listAuditEvents>[0]): Promise<AuditEvent[]> {
  return (await listAuditEvents(filter, { limit: 500 })).events;
}

/** The one event for this entity and action (newest first if several). */
async function one(entity_id: string, action: string): Promise<AuditEvent> {
  const found = await events({ entity_id, action });
  const exact = found.filter((event) => event.action === action);
  expect(exact.length, `${action} on ${entity_id}`).toBeGreaterThan(0);
  return exact[0]!;
}

const savedOwners = process.env.OWNER_EMAILS;

beforeEach(() => {
  jar.values.clear();
  process.env.OWNER_EMAILS = "";
});

afterAll(async () => {
  if (savedOwners === undefined) delete process.env.OWNER_EMAILS;
  else process.env.OWNER_EMAILS = savedOwners;
  await deleteCustomersLike(`${PREFIX}%`);
  await deleteAccountsLike(`kan88-%-${run}@%`);
});

describe("KAN-88: user administration is audited", () => {
  it("records every Users action with before/after and the admin who did it, never a password", async () => {
    const admin = await signInAdmin();
    withCookie(admin);
    const act = async (body: Record<string, unknown>) => {
      withCookie(admin);
      const res = await read(await usersPost(jsonRequest("/api/admin/users", "POST", body)));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body;
    };
    const created = await act({ action: "create", email: at("staff"), name: "KAN-88 Staff" });
    const id = String((created.user as { id: string }).id);
    const temporary = String(created.temporary_password);
    const reset = await act({ action: "reset_password", id });
    await act({ action: "set_admin", id, is_admin: true });
    await act({ action: "set_role", id, role: "contributor" });
    await act({ action: "verify", id });
    await act({ action: "set_disabled", id, disabled: true });
    await act({ action: "set_disabled", id, disabled: false });
    await act({ action: "unlock", id });
    await act({ action: "delete", id });

    const all = await events({ entity_id: id, category: "admin" });
    expect(all.map((event) => event.action).reverse()).toEqual([
      "user.create",
      "user.reset_password",
      "user.set_admin",
      "user.set_role",
      "user.verify",
      "user.set_disabled",
      "user.set_disabled",
      "user.unlock",
      "user.delete",
    ]);
    for (const event of all) {
      expect(event.actor_principal).toBe(at("admin"));
      expect(event.actor_role).toBe("operator");
      expect(event.request_id).toBe("kan88-request-0001");
    }
    const text = JSON.stringify(all);
    expect(text).not.toContain(temporary);
    expect(text).not.toContain(String(reset.temporary_password));
    expect(text).not.toContain("password_hash");

    const create = all.find((event) => event.action === "user.create")!;
    expect(create.before).toBeNull();
    expect(create.after).toMatchObject({ email: at("staff"), role: "operator", is_admin: false });
    expect((await one(id, "user.reset_password")).meta).toMatchObject({ password_reset: true });
    const role = await one(id, "user.set_role");
    expect(role.before).toMatchObject({ role: "operator" });
    expect(role.after).toMatchObject({ role: "contributor" });
    const disabled = all.filter((event) => event.action === "user.set_disabled");
    expect(disabled[1]!.after).toMatchObject({ disabled: true });
    expect(disabled[0]!.after).toMatchObject({ disabled: false });
    const deleted = await one(id, "user.delete");
    expect(deleted.before).toMatchObject({ email: at("staff") });
    expect(deleted.after).toBeNull();
  });

  it("records a person changing their own password, never the password", async () => {
    const admin = await signInAdmin();
    withCookie(admin);
    const next = "copper-meadow-lantern-88";
    const res = await changePassword(jsonRequest("/api/account/password", "POST", { current: PASSWORD, next, confirm: next }));
    expect(res.status).toBe(200);
    const account = (await findAccountByEmail(at("admin")))!;
    const event = await one(account.id, "account.change_password");
    expect(event.actor_principal).toBe(at("admin"));
    expect(event.meta).toMatchObject({ password_changed: true });
    expect(JSON.stringify(event)).not.toContain(next);
    expect(JSON.stringify(event)).not.toContain(PASSWORD);
    // Put it back for the other tests.
    await ensureAdminAccount({ email: at("admin"), name: "KAN-88 Admin", password: PASSWORD });
  });
});

describe("KAN-88: customers and seats are audited", () => {
  it("records create, update, deactivate, seat assign and unassign, and delete with cascade counts", async () => {
    const admin = await signInAdmin();
    withCookie(admin);
    const created = await read(
      await customersPost(jsonRequest("/api/admin/customers", "POST", { name: `${PREFIX} Acme`, email_domains: DOMAIN, seats: 3 })),
    );
    expect(created.status).toBe(201);
    const id = String((created.body.customer as { id: string }).id);

    withCookie(admin);
    expect((await customerPatch(jsonRequest(`/api/admin/customers/${id}`, "PATCH", { seats: 5 }), ctx(id))).status).toBe(200);
    withCookie(admin);
    const assign = await seatPost(jsonRequest(`/api/admin/customers/${id}/seats`, "POST", { emails: [at("a"), at("b")] }), ctx(id));
    expect(assign.status).toBe(200);
    withCookie(admin);
    expect((await seatDelete(jsonRequest(`/api/admin/customers/${id}/seats`, "DELETE", { email: at("b") }), ctx(id))).status).toBe(200);
    withCookie(admin);
    expect((await customerPatch(jsonRequest(`/api/admin/customers/${id}`, "PATCH", { active: false }), ctx(id))).status).toBe(200);
    withCookie(admin);
    expect((await customerDelete(jsonRequest(`/api/admin/customers/${id}`, "DELETE"), ctx(id))).status).toBe(200);

    const all = await events({ entity_id: id });
    expect(all.map((event) => event.action).reverse()).toEqual([
      "customer.create",
      "customer.update",
      "seat.assign",
      "seat.unassign",
      "customer.deactivate",
      "customer.delete",
    ]);
    for (const event of all) {
      expect(event.actor_principal).toBe(at("admin"));
      expect(event.customer_id).toBe(id);
    }
    const update = await one(id, "customer.update");
    expect(update.before).toMatchObject({ seats: 3 });
    expect(update.after).toMatchObject({ seats: 5 });
    expect((await one(id, "seat.assign")).after).toMatchObject({ seats_used: 2, assigned: [at("a"), at("b")] });
    expect((await one(id, "seat.unassign")).before).toMatchObject({ email: at("b"), seats_used: 2 });
    const deactivate = await one(id, "customer.deactivate");
    expect(deactivate.before).toMatchObject({ active: true });
    expect(deactivate.after).toMatchObject({ active: false });
    const deleted = await one(id, "customer.delete");
    expect(deleted.before).toMatchObject({ name: `${PREFIX} Acme`, seats_used: 1 });
    expect(deleted.meta).toMatchObject({ seats_removed: 1, sessions_revoked: 0 });
  });
});

describe("KAN-88: sign-in is audited", () => {
  it("records a failed sign-in with its reason and the attempted email, never the password", async () => {
    const tried = `NOBODY-${run}@${DOMAIN.toUpperCase()}`;
    expect((await login(tried, "guess-one-two-three")).status).toBe(401);
    const unknown = (await events({ category: "auth", action: "auth.login_failed", actor: tried.toLowerCase() }))[0]!;
    expect(unknown.meta).toMatchObject({ reason: "unknown_email", email: tried.toLowerCase() });
    expect(unknown.actor_principal).toBe(tried.toLowerCase());
    expect(JSON.stringify(unknown)).not.toContain("guess-one-two-three");

    await ensureAdminAccount({ email: at("victim"), name: "KAN-88 Victim", password: PASSWORD });
    const victim = (await findAccountByEmail(at("victim")))!;
    for (let i = 0; i < 5; i += 1) await login(at("victim"), `wrong-${i}-password-xyz`);
    expect((await login(at("victim"))).status).toBe(423);
    const failures = await events({ entity_id: victim.id, action: "auth.login_failed" });
    const reasons = failures.map((event) => event.meta?.reason).reverse();
    expect(reasons).toEqual(["wrong_password", "wrong_password", "wrong_password", "wrong_password", "wrong_password", "locked"]);
    expect(JSON.stringify(failures)).not.toMatch(/wrong-\d-password/);
    expect((await one(victim.id, "auth.lockout")).after).toEqual({ locked: true });
  });

  it("records disabled and no-active-seat refusals", async () => {
    await ensureAdminAccount({ email: at("off"), name: "KAN-88 Off", password: PASSWORD });
    const off = (await findAccountByEmail(at("off")))!;
    await updateAccount(off.id, { disabled: true });
    expect((await login(at("off"))).status).toBe(403);
    expect((await one(off.id, "auth.login_failed")).meta).toMatchObject({ reason: "disabled" });

    const { account, customer } = await ensureTestCustomer({
      email: at("tester"),
      password: PASSWORD,
      customer_name: `${PREFIX} Test customer`,
    });
    await updateCustomer(customer.id, { active: false });
    expect((await login(at("tester"))).status).toBe(403);
    expect((await one(account.id, "auth.login_failed")).meta).toMatchObject({ reason: "no_active_seat" });
  });

  it("records a successful sign-in and the sign-out", async () => {
    const cookie = await signInAdmin();
    const account = (await findAccountByEmail(at("admin")))!;
    const signedIn = await one(account.id, "auth.login");
    expect(signedIn.actor_principal).toBe(at("admin"));
    expect(signedIn.meta).toMatchObject({ method: "password" });
    withCookie(cookie);
    expect((await logoutPost()).status).toBe(200);
    expect((await one(account.id, "auth.logout")).actor_principal).toBe(at("admin"));
  });
});

describe("KAN-87: the audit log page and export", () => {
  it("exports CSV and JSON for the owner, filtered, and refuses anyone else", async () => {
    await ensureAdminAccount({ email: at("victim"), name: "KAN-88 Victim", password: PASSWORD });
    const victim = (await findAccountByEmail(at("victim")))!;
    const admin = await signInAdmin();

    withCookie(admin);
    const csv = await auditGet(new Request(`http://localhost/api/admin/audit?entity_id=${victim.id}&action=lockout&format=csv`));
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="synapse-audit-.*\.csv"/);
    const lines = (await csv.text()).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("auth.lockout");

    withCookie(admin);
    const json = await auditGet(new Request(`http://localhost/api/admin/audit?entity_id=${victim.id}&category=auth&format=json`));
    const body = (await json.json()) as { events: AuditEvent[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.events.every((event) => event.entity_id === victim.id && event.category === "auth")).toBe(true);

    jar.values.clear();
    jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
    expect((await auditGet(new Request("http://localhost/api/admin/audit?format=csv"))).status).toBe(403);
  });

  it("renders the filtered log with the before/after diff and export links", async () => {
    await ensureAdminAccount({ email: at("victim"), name: "KAN-88 Victim", password: PASSWORD });
    const victim = (await findAccountByEmail(at("victim")))!;
    const element = await AuditPage({ searchParams: Promise.resolve({ entity_id: victim.id, action: "lockout" }) });
    const html = renderToStaticMarkup(createElement(() => element));
    expect(html).toContain("Audit log");
    expect(html).toContain("auth.lockout");
    expect(html).toContain(`format=csv`);
    expect(html).toContain(`entity_id=${victim.id}`);
    expect(html).toMatch(/<td[^>]*>locked<\/td>/);
  });
});
