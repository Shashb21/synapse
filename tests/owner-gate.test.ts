import { afterEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));

import "@/modules";
import { ownerDecision, ownerEmails, testOwnerBypass, type OwnerSubject } from "@/modules/auth/roles";
import { ownerAccess, requireOwnerPage, TEST_AS_CUSTOMER_COOKIE } from "@/modules/auth/owner";
import { GET as controlGet, POST as controlPost } from "@/app/api/control/route";
import { GET as modulesGet, POST as modulesPost } from "@/app/api/modules/route";
import { POST as evalsPost } from "@/app/api/modules/evals/route";
import { POST as hillclimbPost } from "@/app/api/modules/hillclimb/route";
import { GET as orchestrationGet } from "@/app/api/accuracy/orchestration/route";
import { GET as workspacesGet } from "@/app/api/accuracy/workspaces/route";
import { GET as docGet } from "@/app/admin/docs/sdlc/[slug]/route";
import nextConfig, { ADMIN_REDIRECTS } from "../next.config";

const customer: OwnerSubject = {
  role: "medical_affairs",
  email: "lead@customer.example",
  signed_in: true,
  demo: false,
  provider_id: "okta",
};

function post(url: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });
}

function asCustomer() {
  jar.values.set(TEST_AS_CUSTOMER_COOKIE, "customer");
}

afterEach(() => jar.values.clear());

describe("who the owner is", () => {
  it("is the operator role", () => {
    expect(ownerDecision({ ...customer, role: "operator" }, { bypass: false }).owner).toBe(true);
  });

  it("is a signed-in email listed in OWNER_EMAILS, case-insensitively", () => {
    expect(ownerEmails(" Owner@Kernel.example , ,second@x.example")).toEqual([
      "owner@kernel.example",
      "second@x.example",
    ]);
    const owner = { ...customer, email: "OWNER@kernel.example" };
    expect(ownerDecision(owner, { emails: ["owner@kernel.example"], bypass: false })).toEqual({
      owner: true,
      reason: "listed in OWNER_EMAILS",
    });
    // Only a signed-in session's email counts.
    expect(ownerDecision({ ...owner, signed_in: false }, { emails: ["owner@kernel.example"], bypass: false }).owner).toBe(
      false,
    );
  });

  it("is nobody else", () => {
    expect(ownerDecision(customer, { emails: ["owner@kernel.example"], bypass: false }).owner).toBe(false);
    expect(ownerDecision({ ...customer, role: "contributor" }, { emails: [], bypass: false }).owner).toBe(false);
    expect(ownerDecision({ ...customer, role: "viewer" }, { emails: [], bypass: false }).owner).toBe(false);
  });

  it("treats the demo session as owner only under the test stub, never in production", () => {
    const demo: OwnerSubject = { role: "medical_affairs", email: null, signed_in: false, demo: true, provider_id: null };
    expect(ownerDecision(demo, { emails: [], bypass: true }).owner).toBe(true);
    expect(ownerDecision(demo, { emails: [], bypass: false }).owner).toBe(false);
    expect(ownerDecision(demo, { emails: [], bypass: true, optOut: true }).owner).toBe(false);
    // A real identity-provider session never rides the bypass.
    expect(ownerDecision(customer, { emails: [], bypass: true }).owner).toBe(false);

    expect(testOwnerBypass({ NODE_ENV: "test", SYNAPSE_TEST_STUB_LLM: "1" })).toBe(true);
    expect(testOwnerBypass({ NODE_ENV: "production", SYNAPSE_TEST_STUB_LLM: "1" })).toBe(false);
    expect(testOwnerBypass({ NODE_ENV: "development" })).toBe(false);
  });

  it("resolves the request: owner under the stub, customer with the opt-out cookie", async () => {
    expect((await ownerAccess()).owner).toBe(true);
    asCustomer();
    expect((await ownerAccess()).owner).toBe(false);
  });

  it("renders the Owner only page (403) for a customer on an admin page", async () => {
    // next.config's experimental.authInterrupts sets this for the app; vitest does not load it.
    process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "true";
    asCustomer();
    const failure = await requireOwnerPage().then(
      () => null,
      (error: unknown) => error as { digest?: string },
    );
    expect(failure?.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;403");
  });
});

describe("admin APIs are owner only", () => {
  it("answers the owner", async () => {
    expect((await controlGet()).status).toBe(200);
    expect((await orchestrationGet()).status).toBe(200);
    expect((await modulesGet()).status).toBe(200);
  });

  it("refuses a customer with 403 owner_only", async () => {
    asCustomer();
    const responses = await Promise.all([
      controlGet(),
      modulesGet(),
      orchestrationGet(),
      workspacesGet(new Request("http://localhost/api/accuracy/workspaces")),
      controlPost(post("/api/control", { action: "set_ai_enabled", enabled: false })),
      controlPost(post("/api/control", { action: "set_route", stage: "S2", provider_id: "xai-grok", model: "grok-4" })),
      controlPost(post("/api/control", { action: "set_default_provider", provider_id: "anthropic-claude" })),
      controlPost(post("/api/control", { action: "activate_module", stage: "S2", module_id: "x" })),
      controlPost(post("/api/control", { action: "connect_provider", provider_id: "xai-grok" })),
      controlPost(post("/api/control", { action: "disconnect_provider", provider_id: "xai-grok" })),
      evalsPost(post("/api/modules/evals", { stage: "S2" })),
      hillclimbPost(post("/api/modules/hillclimb", { stage: "S2" })),
      docGet(new Request("http://localhost/admin/docs/sdlc/01-requirements.md"), {
        params: Promise.resolve({ slug: "01-requirements.md" }),
      }),
    ]);
    for (const [index, res] of responses.entries()) {
      expect(res.status, `response ${index}`).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("owner_only");
    }
  });

  it("leaves customer actions open: plain stage runs, sign-out, prioritization axes", async () => {
    asCustomer();
    // Not gated: an unknown stage is rejected for what it is, not for who asked.
    expect((await modulesPost(post("/api/modules", { stage: "S99" }))).status).toBe(400);
    expect((await controlPost(post("/api/control", { action: "sign_out" }))).status).toBe(200);
    const axes = await controlPost(post("/api/control", { action: "save_axes", config: {} }));
    expect(axes.status).not.toBe(403);
  });
});

describe("old lab URLs redirect into the owner console", () => {
  it("covers every moved surface", async () => {
    const rules = await nextConfig.redirects!();
    const destination = (source: string) => rules.find((rule) => rule.source === source)?.destination;
    expect(destination("/accuracy")).toBe("/admin/accuracy");
    expect(destination("/accuracy/:path*")).toBe("/admin/accuracy/:path*");
    expect(destination("/accuracy/control")).toBe("/admin/accuracy/routing");
    expect(destination("/control")).toBe("/admin/control");
    expect(destination("/control-panel")).toBe("/admin/control");
    expect(destination("/pipeline")).toBe("/admin/pipeline");
    expect(destination("/runs/:path*")).toBe("/admin/runs/:path*");
    for (const path of ["/evals", "/catalog", "/sdlc", "/docs"]) expect(destination(path)).toBe(`/admin${path}`);
    // The specific /accuracy/control rule must win over the /accuracy/:path* catch-all.
    const sources = ADMIN_REDIRECTS.map((rule) => rule.source);
    expect(sources.indexOf("/accuracy/control")).toBeLessThan(sources.indexOf("/accuracy/:path*"));
    expect(rules.every((rule) => rule.destination.startsWith("/admin"))).toBe(true);
  });
});
