import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { POST as passwordSignup } from "@/app/api/auth/password/signup/route";
import { POST as changePassword } from "@/app/api/account/password/route";
import { GET as usersGet, POST as usersPost } from "@/app/api/admin/users/route";
import {
  createAccount,
  deleteAccountsLike,
  findAccountByEmail,
  getAccount,
  MAX_FAILED_ATTEMPTS,
} from "@/modules/auth/accounts";
import { ensureAdminAccount } from "@/modules/auth/admin-setup";
import { ownerAccess } from "@/modules/auth/owner";
import { INCORRECT_CREDENTIALS } from "@/modules/auth/password-login";
import { currentSession, SESSION_COOKIE } from "@/modules/auth/session";
import { principalOf } from "@/modules/workspaces/session";
import { createWorkspace, inviteMember, memberRole } from "@/modules/workspaces/store";

const run = Math.random().toString(36).slice(2, 8);
const DOMAIN = "kan22.example.test";
const email = (who: string) => `kan22-${who}-${run}@${DOMAIN}`;
const PASSWORD = "violet-harbour-lantern-7";

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function login(address: string, password: string) {
  jar.values.clear();
  return json(await passwordLogin(post("/api/auth/password/login", { email: address, password })));
}

async function verifiedUser(who: string, extra: Partial<Parameters<typeof createAccount>[0]> = {}) {
  return createAccount({
    email: email(who),
    name: `KAN-22 ${who}`,
    password: PASSWORD,
    email_verified: true,
    created_by: "test",
    ...extra,
  });
}

const savedEnv = { ALLOW_SIGNUP: process.env.ALLOW_SIGNUP, OWNER_EMAILS: process.env.OWNER_EMAILS, ALLOWED_EMAIL_DOMAINS: process.env.ALLOWED_EMAIL_DOMAINS };

beforeEach(() => {
  jar.values.clear();
  delete process.env.ALLOW_SIGNUP;
  delete process.env.ALLOWED_EMAIL_DOMAINS;
  process.env.OWNER_EMAILS = savedEnv.OWNER_EMAILS ?? "";
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await deleteAccountsLike(`kan22-%-${run}@${DOMAIN}`);
});

describe("KAN-22 password sign-in", () => {
  it("signs in with the right password: a password session with the verified email and the account's role", async () => {
    const account = await verifiedUser("ok", { role: "medical_affairs", actor_function: "heor" });
    const res = await login(email("ok").toUpperCase(), PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.redirect).toBe("/workspaces");
    expect(jar.values.get(SESSION_COOKIE)).toBeTruthy();
    const session = await currentSession();
    expect(session).toMatchObject({
      provider_id: "password",
      subject: account.id,
      email: email("ok"),
      role: "medical_affairs",
      actor: { name: "KAN-22 ok", function: "heor" },
    });
    expect((await getAccount(account.id))?.last_sign_in_at).toBeTruthy();
  });

  it("a wrong password and an unknown email get the same generic message", async () => {
    await verifiedUser("wrong");
    const wrong = await login(email("wrong"), "not-the-password-at-all");
    const unknown = await login(email("nobody"), PASSWORD);
    const empty = await login("", "");
    for (const res of [wrong, unknown, empty]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe(INCORRECT_CREDENTIALS);
      expect(jar.values.get(SESSION_COOKIE)).toBeUndefined();
    }
  });

  it(`locks after ${MAX_FAILED_ATTEMPTS} failures for 15 minutes, then admits the right password once it expires`, async () => {
    const account = await verifiedUser("lock");
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      expect((await login(email("lock"), `bad-password-${i}-xx`)).status).toBe(401);
    }
    const fifth = await login(email("lock"), "bad-password-5-xx");
    expect(fifth.status).toBe(423);
    const locked = await getAccount(account.id);
    const minutes = (Date.parse(locked!.locked_until!) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    // Even the right password is refused while locked.
    expect((await login(email("lock"), PASSWORD)).status).toBe(423);
    // Lock expires.
    await sharedDb().execute(
      sql`update user_accounts set locked_until = ${new Date(Date.now() - 1000).toISOString()} where id = ${account.id}`,
    );
    expect((await login(email("lock"), PASSWORD)).status).toBe(200);
    expect((await getAccount(account.id))?.failed_attempts).toBe(0);
  });

  it("a disabled account is refused", async () => {
    await verifiedUser("off", { });
    await sharedDb().execute(sql`update user_accounts set disabled = true where email = ${email("off")}`);
    const res = await login(email("off"), PASSWORD);
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/disabled/);
    // Wrong password on a disabled account still says only "incorrect".
    expect((await login(email("off"), "some-other-password")).body.error).toBe(INCORRECT_CREDENTIALS);
  });
});

describe("KAN-22 sign-up", () => {
  it("creates an unverified contributor, signs them in as password:<id>, and never matches an invite or OWNER_EMAILS", async () => {
    const address = email("signup");
    process.env.OWNER_EMAILS = address;
    const res = await json(
      await passwordSignup(
        post("/api/auth/password/signup", {
          name: "Sign Up Sam",
          email: address,
          actor_function: "medical_affairs",
          password: PASSWORD,
          confirm: PASSWORD,
        }),
      ),
    );
    expect(res.status).toBe(200);
    const account = await findAccountByEmail(address);
    expect(account).toMatchObject({ role: "contributor", email_verified: false, is_admin: false });
    const session = (await currentSession())!;
    expect(session.email).toBeNull();
    expect(session.role).toBe("contributor");
    expect(principalOf(session)).toBe(`password:${account!.id}`);

    const ws = await createWorkspace({ name: `KAN-22 invite ${run}`, owner: email("wsowner") });
    await inviteMember({ workspace_id: ws.id, email: address, by: email("wsowner") });
    expect(await memberRole(ws.id, principalOf(session))).toBeNull();
    expect((await ownerAccess()).owner).toBe(false);
  });

  it("an admin-created (verified) account matches its email invite", async () => {
    await verifiedUser("invited");
    const ws = await createWorkspace({ name: `KAN-22 verified ${run}`, owner: email("wsowner2") });
    await inviteMember({ workspace_id: ws.id, email: email("invited"), by: email("wsowner2") });
    expect((await login(email("invited"), PASSWORD)).status).toBe(200);
    const session = (await currentSession())!;
    expect(principalOf(session)).toBe(email("invited"));
    expect(await memberRole(ws.id, principalOf(session))).toBe("member");
  });

  it("refuses weak passwords, mismatched confirmation and taken emails; ALLOW_SIGNUP=0 closes it; domains are enforced", async () => {
    const body = { name: "Weak Will", email: email("weak"), actor_function: "heor" };
    expect((await passwordSignup(post("/x", { ...body, password: "short", confirm: "short" }))).status).toBe(400);
    expect((await passwordSignup(post("/x", { ...body, password: PASSWORD, confirm: `${PASSWORD}!` }))).status).toBe(400);
    await verifiedUser("taken");
    const taken = await passwordSignup(post("/x", { ...body, email: email("taken"), password: PASSWORD, confirm: PASSWORD }));
    expect(taken.status).toBe(409);

    process.env.ALLOW_SIGNUP = "0";
    const closed = await json(await passwordSignup(post("/x", { ...body, password: PASSWORD, confirm: PASSWORD })));
    expect(closed.status).toBe(403);
    expect(closed.body.code).toBe("signup_closed");
    delete process.env.ALLOW_SIGNUP;

    process.env.ALLOWED_EMAIL_DOMAINS = "elsewhere.example";
    expect((await passwordSignup(post("/x", { ...body, password: PASSWORD, confirm: PASSWORD }))).status).toBe(400);
    expect(await findAccountByEmail(email("weak"))).toBeNull();
  });
});

describe("KAN-22 account and admin", () => {
  it("changing a password needs the current one", async () => {
    await verifiedUser("change");
    expect((await login(email("change"), PASSWORD)).status).toBe(200);
    const next = "copper-meadow-sparrow-19";
    const wrong = await changePassword(post("/api/account/password", { current: "not-it-at-all!", next, confirm: next }));
    expect(wrong.status).toBe(400);
    const weak = await changePassword(post("/api/account/password", { current: PASSWORD, next: "short", confirm: "short" }));
    expect(weak.status).toBe(400);
    const ok = await changePassword(post("/api/account/password", { current: PASSWORD, next, confirm: next }));
    expect(ok.status).toBe(200);
    expect((await login(email("change"), PASSWORD)).status).toBe(401);
    expect((await login(email("change"), next)).status).toBe(200);

    jar.values.clear();
    expect((await changePassword(post("/api/account/password", { current: next, next: PASSWORD }))).status).toBe(401);
  });

  it("create-admin core creates a verified operator admin, and resets its password (clearing lockout)", async () => {
    const address = email("admin");
    const first = await ensureAdminAccount({ email: address, name: "First Admin", password: PASSWORD });
    expect(first.created).toBe(true);
    expect(first.account).toMatchObject({ email: address, is_admin: true, email_verified: true, role: "operator", name: "First Admin" });

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await login(address, `bad-password-${i}-xx`);
    expect((await login(address, PASSWORD)).status).toBe(423);

    const reset = "juniper-quartz-ember-88";
    const second = await ensureAdminAccount({ email: address.toUpperCase(), password: reset });
    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.name).toBe("First Admin");
    expect((await login(address, PASSWORD)).status).toBe(401);
    expect((await login(address, reset)).status).toBe(200);

    await expect(ensureAdminAccount({ email: address, password: "short" })).rejects.toThrow(/12 characters/);
    await expect(ensureAdminAccount({ email: "not-an-email", password: PASSWORD })).rejects.toThrow(/valid email/);

    // A self sign-up with the same email is taken over: promoted, verified, new password.
    const squatter = email("squat");
    await createAccount({ email: squatter, name: "Squatter", password: PASSWORD, created_by: "self-signup" });
    const taken = await ensureAdminAccount({ email: squatter, password: reset });
    expect(taken.account).toMatchObject({ is_admin: true, email_verified: true, role: "operator" });
  });

  it("an admin account passes the owner gate (200); a plain account gets 403", async () => {
    const adminEmail = email("gate-admin");
    await ensureAdminAccount({ email: adminEmail, name: "Gate Admin", password: PASSWORD });
    // A viewer-role admin shows it is is_admin, not the operator role, that grants owner.
    await sharedDb().execute(sql`update user_accounts set role = 'viewer' where email = ${adminEmail}`);
    expect((await login(adminEmail, PASSWORD)).status).toBe(200);
    expect((await currentSession())?.role).toBe("viewer");
    const allowed = await json(await usersGet());
    expect(allowed.status).toBe(200);
    expect((allowed.body.users as { email: string }[]).some((u) => u.email === adminEmail)).toBe(true);
    expect(JSON.stringify(allowed.body)).not.toContain("password_hash");
    expect(JSON.stringify(allowed.body)).not.toContain("scrypt$");

    await verifiedUser("gate-plain");
    expect((await login(email("gate-plain"), PASSWORD)).status).toBe(200);
    expect((await usersGet()).status).toBe(403);
    expect((await usersPost(post("/api/admin/users", { action: "create", email: email("x"), name: "X" }))).status).toBe(403);
  });

  it("the admin users API: create, reset, verify, role, disable, unlock; refuses non-owners and self-demotion", async () => {
    const adminEmail = email("ops");
    const { account: admin } = await ensureAdminAccount({ email: adminEmail, name: "Ops Admin", password: PASSWORD });
    expect((await login(adminEmail, PASSWORD)).status).toBe(200);
    const call = async (body: Record<string, unknown>) => json(await usersPost(post("/api/admin/users", body)));

    const created = await call({ action: "create", email: email("made"), name: "Made Maria", role: "medical_affairs" });
    expect(created.status).toBe(200);
    const temp = String(created.body.temporary_password);
    expect(temp.length).toBeGreaterThanOrEqual(12);
    const made = created.body.user as { id: string; email_verified: boolean; role: string };
    expect(made).toMatchObject({ email_verified: true, role: "medical_affairs" });
    expect((await call({ action: "create", email: email("made"), name: "Again" })).status).toBe(409);

    const reset = await call({ action: "reset_password", id: made.id });
    const temp2 = String(reset.body.temporary_password);
    expect(temp2).not.toBe(temp);

    expect((await call({ action: "set_role", id: made.id, role: "viewer" })).body.user).toMatchObject({ role: "viewer" });
    expect((await call({ action: "set_role", id: made.id, role: "emperor" })).status).toBe(400);
    expect((await call({ action: "set_disabled", id: made.id, disabled: true })).body.user).toMatchObject({ disabled: true });
    expect((await call({ action: "set_disabled", id: made.id, disabled: false })).body.user).toMatchObject({ disabled: false });

    const self = await findAccountByEmail(email("ops"));
    expect(self?.id).toBe(admin.id);
    expect((await call({ action: "set_role", id: admin.id, role: "viewer" })).status).toBe(400);
    expect((await call({ action: "set_disabled", id: admin.id, disabled: true })).status).toBe(400);
    expect((await call({ action: "set_admin", id: admin.id, is_admin: false })).status).toBe(400);
    expect(await getAccount(admin.id)).toMatchObject({ role: "operator", disabled: false, is_admin: true });
    expect((await call({ action: "nope", id: admin.id })).status).toBe(400);
    expect((await call({ action: "unlock", id: "acct_missing" })).status).toBe(404);

    // Verify a self sign-up; unlock a locked account.
    const unverified = await createAccount({ email: email("unv"), name: "Unv", password: PASSWORD, created_by: "self-signup" });
    expect((await call({ action: "verify", id: unverified.id })).body.user).toMatchObject({ email_verified: true });
    await sharedDb().execute(
      sql`update user_accounts set locked_until = ${new Date(Date.now() + 600_000).toISOString()} where id = ${unverified.id}`,
    );
    expect((await call({ action: "unlock", id: unverified.id })).body.user).toMatchObject({ locked: false });

    // The temporary password works (the admin's own session is replaced by this sign-in).
    expect((await login(email("made"), temp2)).status).toBe(200);
    // ...and that non-admin session is refused by the API.
    expect((await call({ action: "set_role", id: admin.id, role: "viewer" })).status).toBe(403);
  });

  it("disabling an account ends its sessions at once", async () => {
    const adminEmail = email("revoker");
    await ensureAdminAccount({ email: adminEmail, password: PASSWORD });
    const target = await verifiedUser("revoked");
    expect((await login(email("revoked"), PASSWORD)).status).toBe(200);
    const targetCookie = jar.values.get(SESSION_COOKIE)!;
    expect((await login(adminEmail, PASSWORD)).status).toBe(200);
    expect((await usersPost(post("/api/admin/users", { action: "set_disabled", id: target.id, disabled: true }))).status).toBe(200);
    jar.values.clear();
    jar.values.set(SESSION_COOKIE, targetCookie);
    expect(await currentSession()).toBeNull();
  });
});
