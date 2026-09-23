import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke coverage for the accuracy-first shell. No module runs, no Llama —
 * just that /accuracy routes render with the shared nav.
 */

const SHELL_NAV = [
  { href: "/accuracy", label: "Workspaces" },
  { href: "/accuracy/sources", label: "Sources" },
  { href: "/accuracy/review", label: "Review" },
  { href: "/accuracy/ledger", label: "Ledger" },
  { href: "/accuracy/coverage", label: "Coverage" },
  { href: "/accuracy/plan", label: "Plan" },
  { href: "/accuracy/timeline", label: "Timeline" },
  { href: "/accuracy/audit", label: "Audit" },
  { href: "/accuracy/control", label: "Routing" },
  { href: "/accuracy/runs", label: "Runs" },
] as const;

async function expectAccuracyShell(page: Page) {
  const nav = page.getByRole("navigation", { name: /^accuracy$/i });
  await expect(nav).toBeVisible();
  for (const item of SHELL_NAV) {
    await expect(nav.getByRole("link", { name: item.label })).toHaveAttribute("href", item.href);
  }
  await expect(page.getByRole("link", { name: /synapse · accuracy/i })).toBeVisible();
}

test.describe("accuracy shell", () => {
  test("workspaces page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy");
    await expect(page.getByRole("heading", { name: /^workspaces$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("ledger page renders shell nav and empty state", async ({ page }) => {
    await page.goto("/accuracy/ledger");
    await expect(page.getByRole("heading", { name: /^ledger$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /choose a workspace/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^workspaces$/i }).first()).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("timeline page renders shell nav and empty state", async ({ page }) => {
    await page.goto("/accuracy/timeline");
    await expect(page.getByRole("heading", { name: /^timeline$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /choose a workspace/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("sources page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy/sources");
    await expect(page.getByRole("heading", { name: /^sources$/i })).toBeVisible();
    await expect(page.getByText(/need \+ inventory extract/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /control panel/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("review page renders shell nav and empty state", async ({ page }) => {
    await page.goto("/accuracy/review");
    await expect(page.getByRole("heading", { name: /^review$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /choose a workspace/i })).toBeVisible();
    await expect(page.getByText(/miss flags from parse blocks/i)).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("shell nav preserves workspace_id query", async ({ page }) => {
    await page.goto("/accuracy/ledger?workspace_id=ws-demo-preserve");
    const nav = page.getByRole("navigation", { name: /^accuracy$/i });
    await expect(nav.getByRole("link", { name: "Sources" })).toHaveAttribute(
      "href",
      "/accuracy/sources?workspace_id=ws-demo-preserve",
    );
    await expect(nav.getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/accuracy/review?workspace_id=ws-demo-preserve",
    );
    await expect(nav.getByRole("link", { name: "Plan" })).toHaveAttribute(
      "href",
      "/accuracy/plan?workspace_id=ws-demo-preserve",
    );
    await expect(nav.getByRole("link", { name: "Workspaces" })).toHaveAttribute("href", "/accuracy");
  });

  test("coverage page renders shell nav and one-pair queue copy", async ({ page }) => {
    await page.goto("/accuracy/coverage");
    await expect(page.getByRole("heading", { name: /^coverage$/i })).toBeVisible();
    await expect(page.getByText(/one undecided gap/i)).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("plan page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy/plan");
    await expect(page.getByRole("heading", { name: /^plan$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("audit page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy/audit");
    await expect(page.getByRole("heading", { name: /^audit$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("control page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy/control");
    await expect(page.getByRole("heading", { name: /^accuracy routing$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("runs page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy/runs");
    await expect(page.getByRole("heading", { name: /^runs$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("orchestration API exposes reference packs and modules", async ({ request }) => {
    const res = await request.get("/api/accuracy/orchestration");
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      reference_packs: string[];
      modules: { call_kind: string }[];
    };
    expect(body.reference_packs).toContain("beone-bgb-58067-prmt5i");
    expect(body.modules.some((m) => m.call_kind === "need_extract")).toBe(true);
    expect(body.modules.some((m) => m.call_kind === "gantt_project")).toBe(true);
    expect(body.modules.some((m) => m.call_kind === "validation_gate")).toBe(true);
  });
});
