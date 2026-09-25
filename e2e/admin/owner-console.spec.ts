import { expect, test } from "@playwright/test";

/**
 * The owner console (/admin): the owner gets in, everyone else gets "Owner
 * only" (403), and the old lab URLs redirect into it. Under the test stub the
 * demo session is the owner; the synapse_test_as=customer cookie opts a test
 * out of that so the customer view can be checked.
 */

const CUSTOMER = { cookie: "synapse_test_as=customer" };

test.describe("owner console", () => {
  test("the owner sees Synapse Admin with its own nav", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByTestId("admin-shell")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^synapse admin$/i })).toBeVisible();
    const nav = page.getByRole("navigation", { name: /^admin$/i });
    for (const [label, href] of [
      ["Overview", "/admin"],
      ["AI & routing", "/admin/control"],
      ["Accuracy", "/admin/accuracy"],
      ["Pipeline", "/admin/pipeline"],
      ["Runs & traces", "/admin/runs"],
      ["Evals", "/admin/evals"],
      ["Catalog", "/admin/catalog"],
      ["Module versions", "/admin/modules"],
      ["SDLC", "/admin/sdlc"],
      ["Docs", "/admin/docs"],
    ] as const) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
    }
    await expect(page.getByTestId("admin-workspace")).toBeVisible();
    await expect(page.getByRole("link", { name: "Switch", exact: true })).toHaveAttribute("href", "/workspaces");
  });

  for (const path of ["/admin/control", "/admin/catalog", "/admin/modules", "/admin/docs", "/admin/evals"]) {
    test(`the owner can open ${path}`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByTestId("admin-shell")).toBeVisible();
    });
  }

  test("a customer gets the Owner only page with a 403", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "synapse_test_as", value: "customer", url: baseURL! }]);
    for (const path of ["/admin", "/admin/accuracy", "/admin/control", "/admin/runs"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(403);
      await expect(page.getByRole("heading", { name: /^owner only$/i })).toBeVisible();
      await expect(page.getByTestId("admin-shell")).toHaveCount(0);
    }
  });

  test("admin APIs refuse a customer with 403", async ({ request }) => {
    const checks = [
      request.get("/api/accuracy/orchestration", { headers: CUSTOMER }),
      request.get("/api/control", { headers: CUSTOMER }),
      request.get("/api/modules", { headers: CUSTOMER }),
      request.post("/api/control", {
        headers: CUSTOMER,
        data: { action: "set_ai_enabled", enabled: false },
      }),
      request.post("/api/modules/evals", { headers: CUSTOMER, data: { stage: "S2" } }),
      request.post("/api/modules/hillclimb", { headers: CUSTOMER, data: { stage: "S2" } }),
    ];
    for (const res of await Promise.all(checks)) {
      expect(res.status(), res.url()).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("owner_only");
    }
  });

  test("customers still run plain stages and save their axes", async ({ request }) => {
    // Not owner-gated: an unknown stage is a 400, not a 403.
    const run = await request.post("/api/modules", { headers: CUSTOMER, data: { stage: "S99" } });
    expect(run.status()).toBe(400);
    const signOut = await request.post("/api/control", { headers: CUSTOMER, data: { action: "sign_out" } });
    expect(signOut.status()).toBe(200);
  });

  test("the owner reaches the admin APIs", async ({ request }) => {
    expect((await request.get("/api/control")).status()).toBe(200);
    expect((await request.get("/api/accuracy/orchestration")).status()).toBe(200);
  });

  test("the customer app does not link to the owner console", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
  });
});

test.describe("old lab URLs redirect into /admin", () => {
  for (const [from, to] of [
    ["/accuracy", "/admin/accuracy"],
    ["/accuracy/ledger?workspace_id=ws-x", "/admin/accuracy/ledger?workspace_id=ws-x"],
    ["/accuracy/control", "/admin/accuracy/routing"],
    ["/control", "/admin/control"],
    ["/control-panel", "/admin/control"],
    ["/pipeline", "/admin/pipeline"],
    ["/runs", "/admin/runs"],
    ["/runs/run_123", "/admin/runs/run_123"],
    ["/evals", "/admin/evals"],
    ["/catalog", "/admin/catalog"],
    ["/sdlc", "/admin/sdlc"],
    ["/docs", "/admin/docs"],
  ] as const) {
    test(`${from} → ${to}`, async ({ request }) => {
      const res = await request.get(from, { maxRedirects: 0 });
      expect([307, 308]).toContain(res.status());
      expect(res.headers()["location"]).toBe(to);
    });
  }
});
