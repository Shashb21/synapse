import { expect, test } from "@playwright/test";

const NAV = [
  "Monitor",
  "Insights",
  "Catalog",
  "Graph",
  "Ingest",
  "Eval",
  "Spec",
] as const;

async function expectNav(page: import("@playwright/test").Page) {
  const nav = page.getByRole("navigation");
  for (const label of NAV) {
    await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
}

test.describe("REQ-REG-002 complete user flow", () => {
  test("REQ-UX-001 monitor lists themes and Unassigned", async ({ page }) => {
    await page.goto("/");
    await expectNav(page);
    await expect(page.getByRole("heading", { name: /theme monitor/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /access & formulary/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /unassigned/i }).first()).toBeVisible();
    await expect(page.getByText(/known/i).first()).toBeVisible();
    await expect(page.getByText(/unknown/i).first()).toBeVisible();
    await expect(page.getByText(/opportunit/i).first()).toBeVisible();
  });

  test("REQ-UX-002 theme drill-in shows CIR, source, and cross-theme links", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /access & formulary/i }).first().click();
    await expect(page.getByRole("heading", { name: /access & formulary/i })).toBeVisible();
    await expect(page.getByText(/also sit on other themes/i)).toBeVisible();
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.locator('article a[href^="/sources/"]').first()).toBeVisible();
  });

  test("REQ-UX-007 source page lists CIR from that document", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /access & formulary/i }).first().click();
    await page.locator('article a[href^="/sources/"]').first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByText(/blocks/i).first()).toBeVisible();
  });

  test("REQ-UX-003 insights filters by Unassigned and Unknown", async ({ page }) => {
    await page.goto("/insights");
    await expectNav(page);
    await expect(page.getByRole("heading", { name: /all insights/i })).toBeVisible();
    await expect(page.locator("article").first()).toBeVisible();
    await page.getByRole("link", { name: /^unassigned$/i }).first().click();
    await expect(page.getByText(/catalog floor|unassigned/i).first()).toBeVisible();
    await page.goto("/insights?cls=unknown");
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByText(/^unknown$/i).first()).toBeVisible();
  });

  test("REQ-UX-004 catalog shows emerge, split, and accept controls", async ({
    page,
  }) => {
    await page.goto("/catalog");
    await expectNav(page);
    await expect(page.getByRole("heading", { name: /^catalog$/i, level: 1 })).toBeVisible();
    await expect(page.getByText(/when a theme emerges/i)).toBeVisible();
    await expect(page.getByText(/when a theme splits/i)).toBeVisible();
    await expect(page.getByText(/named themes/i).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /accept into catalog/i }).first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^reject$/i }).first()).toBeVisible();
  });

  test("REQ-UX-005 graph shows network and revelations", async ({ page }) => {
    await page.goto("/graph");
    await expectNav(page);
    await expect(page.getByRole("heading", { name: /knowledge graph/i })).toBeVisible();
    await expect(page.getByText(/revealed connections/i)).toBeVisible();
    await expect(page.getByText(/blend|bridge|new implication/i).first()).toBeVisible();
    await expect(page.locator("svg").first()).toBeVisible();
  });

  test("REQ-UX-006 ingest lists sources and an upload control", async ({ page }) => {
    await page.goto("/ingest");
    await expectNav(page);
    await expect(page.getByRole("heading", { name: /ingest a readout/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /source library/i })).toBeVisible();
    await expect(page.locator("input[type=file]")).toBeVisible();
    await expect(page.getByRole("button", { name: /reset to seed corpus/i })).toBeVisible();
    await expect(page.getByText(/velmara/i).first()).toBeVisible();
  });

  test("REQ-UX-008 eval tape is view-only", async ({ page }) => {
    await page.goto("/evals");
    await expectNav(page);
    await expect(page.getByRole("heading", { name: /eval tape/i })).toBeVisible();
    await expect(page.getByText(/view-only/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /run hill-climb/i })).toHaveCount(0);
    await expect(page.getByText("v1.0-baseline")).toBeVisible();
  });

  test("REQ-UX-008 spec tape includes flow diagrams", async ({ page }) => {
    await page.goto("/sdlc");
    await expectNav(page);
    await expect(page.getByRole("heading", { name: /spec tape/i })).toBeVisible();
    await page.getByRole("link", { name: /flow \(process\)/i }).click();
    await expect(page.getByText(/business loop|atomic insights|catalog/i).first()).toBeVisible();
    await page.getByRole("link", { name: /flow \(technical\)/i }).click();
    await expect(page.getByText(/engine-state|assignThemes|POST \/api\/ingest/i).first()).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });
});
