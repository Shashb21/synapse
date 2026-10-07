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

import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { createAccount, deleteAccountsLike } from "@/modules/auth/accounts";
import { ensureAdminAccount, ensureTestCustomer } from "@/modules/auth/admin-setup";
import { assignSeats, createCustomer, deleteCustomersLike, unassignSeat, updateCustomer } from "@/modules/auth/customers";
import { ownerAccess } from "@/modules/auth/owner";
import { NO_ACTIVE_SEAT_MESSAGE } from "@/modules/auth/password-login";
import { currentSession } from "@/modules/auth/session";

const run = Math.random().toString(36).slice(2, 8);
const CUSTOMER = `KAN-59 test ${run}`;
const email = (who: string, domain = "kan59.synapse.test") => `kan59-${who}-${run}@${domain}`;
const PASSWORD = "copper-meadow-signal-4";

function post(body: unknown): Request {
  return new Request("http://localhost/api/auth/password/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function login(address: string, password = PASSWORD) {
  jar.values.clear();
  const res = await passwordLogin(post({ email: address, password }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => jar.values.clear());

afterAll(async () => {
  await deleteCustomersLike(`KAN-59 % ${run}`);
  await deleteAccountsLike(`kan59-%-${run}@%`);
});

describe("KAN-59 test customer account", () => {
  it("creates a non-staff password account holding the customer's one seat, and signs in as a customer", async () => {
    const { created, account, customer } = await ensureTestCustomer({
      email: email("tester"),
      password: PASSWORD,
      customer_name: CUSTOMER,
    });
    expect(created).toBe(true);
    expect(account).toMatchObject({ is_admin: false, role: "medical_affairs", email_verified: true });
    expect(customer).toMatchObject({ name: CUSTOMER, seats: 1, seats_used: 1, active: true });

    const res = await login(email("tester"));
    expect(res.status).toBe(200);
    expect(res.body.redirect).toBe("/workspaces");
    expect(await currentSession()).toMatchObject({ provider_id: "password", email: email("tester") });
    expect((await ownerAccess()).owner).toBe(false);
  });

  it("runs again to reset the password, keeping the one seat", async () => {
    const again = await ensureTestCustomer({ email: email("tester"), password: "amber-quarry-whistle-9", customer_name: CUSTOMER });
    expect(again.created).toBe(false);
    expect(again.customer.seats_used).toBe(1);
    expect((await login(email("tester"))).status).toBe(401);
    expect((await login(email("tester"), "amber-quarry-whistle-9")).status).toBe(200);
  });

  it("ends the session and refuses sign-in once the seat is unassigned or the customer deactivated", async () => {
    const seat = email("seat");
    const customer = await createCustomer({ name: `KAN-59 seat ${run}`, seats: 1 });
    await createAccount({ email: seat, name: "Seat", password: PASSWORD, email_verified: true, role: "medical_affairs", created_by: "test" });
    await assignSeats({ customer_id: customer.id, emails: [seat], by: "test" });
    expect((await login(seat)).status).toBe(200);
    expect(await currentSession()).not.toBeNull();

    await updateCustomer(customer.id, { active: false });
    expect(await currentSession()).toBeNull();
    expect((await login(seat)).status).toBe(403);

    await updateCustomer(customer.id, { active: true });
    expect((await login(seat)).status).toBe(200);
    await unassignSeat({ customer_id: customer.id, email: seat });
    expect(await currentSession()).toBeNull();
    // KAN-68: a test customer without an active seat is told so, not that passwords are staff-only.
    expect(await login(seat)).toMatchObject({ status: 403, body: { code: "not_staff", error: NO_ACTIVE_SEAT_MESSAGE } });
  });

  it("still refuses password sign-in to a customer on a real-world domain, even with a seat", async () => {
    const real = email("real", "kan59-customer.com");
    const customer = await createCustomer({ name: `KAN-59 real ${run}`, seats: 1 });
    await createAccount({ email: real, name: "Real", password: PASSWORD, email_verified: true, role: "medical_affairs", created_by: "test" });
    await assignSeats({ customer_id: customer.id, emails: [real], by: "test" });
    expect(await login(real)).toMatchObject({ status: 403, body: { code: "not_staff" } });
  });

  it("refuses an unverified test account, even with a seat", async () => {
    const unverified = email("unverified");
    const customer = await createCustomer({ name: `KAN-59 unverified ${run}`, seats: 1 });
    await createAccount({ email: unverified, name: "U", password: PASSWORD, email_verified: false, role: "medical_affairs", created_by: "test" });
    await assignSeats({ customer_id: customer.id, emails: [unverified], by: "test" });
    expect((await login(unverified)).status).toBe(403);
  });

  it("refuses a real-world email, a staff account, and an email seated at another customer", async () => {
    await expect(ensureTestCustomer({ email: email("x", "pfizer.com"), password: PASSWORD, customer_name: CUSTOMER })).rejects.toThrow(
      /test-only domain/,
    );

    const staff = email("staff");
    await ensureAdminAccount({ email: staff, password: PASSWORD });
    await expect(ensureTestCustomer({ email: staff, password: PASSWORD, customer_name: `KAN-59 staff ${run}` })).rejects.toThrow(
      /staff account/,
    );

    const elsewhere = email("elsewhere");
    const other = await createCustomer({ name: `KAN-59 other ${run}`, seats: 1 });
    await assignSeats({ customer_id: other.id, emails: [elsewhere], by: "test" });
    await expect(ensureTestCustomer({ email: elsewhere, password: PASSWORD, customer_name: `KAN-59 mine ${run}` })).rejects.toThrow(
      /already holds a seat at KAN-59 other/,
    );
  });
});
