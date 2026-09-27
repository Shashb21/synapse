import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** An in-memory cookie jar standing in for the browser. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  currentSession,
  DEMO_EMAIL_DOMAIN_MESSAGE,
  DEMO_EMAIL_TAKEN_MESSAGE,
  demoEmail,
  demoEmailFor,
  signInDemo,
  testOnlyAddress,
} from "@/modules/auth/session";
import { ownerDecision } from "@/modules/auth/roles";
import { assignSeats, createCustomer, deleteCustomersLike } from "@/modules/auth/customers";
import { principalOf } from "@/modules/workspaces/session";

const unique = () => Math.random().toString(36).slice(2, 8);

function login(body: Record<string, unknown>) {
  return loginPost(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: true, ...body }),
    }),
  );
}

beforeEach(() => {
  jar.clear();
  // Outside the test stub: the plain development build a person runs locally.
  vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
});
afterEach(() => vi.unstubAllEnvs());

describe("which typed demo emails are test-only", () => {
  it("accepts reserved test domains only", () => {
    for (const ok of [
      "priya.shah@runthrough.test",
      "a@example.com",
      "a@team.example.org",
      "a@corp.example",
      "a@demo.synapse.local",
      "a@box.localhost",
    ]) {
      expect(testOnlyAddress(ok), ok).toBe(true);
    }
    for (const bad of ["priya@pfizer.com", "a@examples.com", "a@example.com.evil.io", "not-an-email", "a@test", ""]) {
      expect(testOnlyAddress(bad), bad).toBe(false);
    }
  });
});

describe("demo sign-in uses the typed email when it is safe", () => {
  it("the typed test address becomes the session email and workspace principal", async () => {
    const name = `Priya ${unique()}`;
    const email = `priya.${unique()}@runthrough.test`;
    const res = await login({ actor_name: name, email: email.toUpperCase() });
    expect(res.status).toBe(200);
    const session = (await currentSession())!;
    expect(session.email).toBe(email);
    expect(session.email).not.toMatch(/@demo\.synapse\.local$/);
    expect(principalOf(session)).toBe(email);
    // Still a plain contributor, and never the owner.
    expect(session.role).toBe("contributor");
    expect(
      ownerDecision(
        { role: session.role, email: session.email, signed_in: true, demo: true, provider_id: "demo" },
        { emails: [email], bypass: false },
      ).owner,
    ).toBe(false);
  });

  it("no email: the generated demo address", async () => {
    const name = `Nobody ${unique()}`;
    expect(await demoEmailFor(name, "  ")).toBe(demoEmail(name));
    expect((await login({ actor_name: name })).status).toBe(200);
    expect((await currentSession())!.email).toBe(demoEmail(name));
  });

  it("refuses a real-world address instead of silently replacing it", async () => {
    const res = await login({ actor_name: `Real ${unique()}`, email: "priya.shah@pfizer.com" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(DEMO_EMAIL_DOMAIN_MESSAGE);
    expect(jar.has("synapse_session")).toBe(false);
  });

  it("refuses an OWNER_EMAILS address, even a test-only one", async () => {
    vi.stubEnv("OWNER_EMAILS", "boss@kernel.test");
    await expect(demoEmailFor("Boss", "Boss@Kernel.test")).rejects.toThrow(DEMO_EMAIL_TAKEN_MESSAGE);
  });

  it("refuses an address that holds a customer seat (KAN-28)", async () => {
    const address = `seat.${unique()}@customer.test`;
    const customer = await createCustomer({ name: `Demo email seat ${unique()}`, seats: 1 });
    try {
      await assignSeats({ customer_id: customer.id, emails: [address], by: "test" });
      await expect(demoEmailFor("Seat Taker", address)).rejects.toThrow(DEMO_EMAIL_TAKEN_MESSAGE);
    } finally {
      await deleteCustomersLike(customer.name);
    }
  });

  it("stays refused in production, email or not", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      signInDemo({ actor_name: "Prod", actor_function: "medical_affairs", email: "a@team.test" }),
    ).rejects.toThrow(/not available in production/);
  });
});
