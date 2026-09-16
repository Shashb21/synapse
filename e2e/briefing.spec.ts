import { expect, test } from "@playwright/test";

test.describe("REQ-REG-002 end-to-end regression", () => {
  test("REQ-KNO-004 monitor lists themes with situation briefs", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Synapse").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /theme monitor/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /access & formulary/i })).toBeVisible();
    await expect(page.getByText(/as of/i).first()).toBeVisible();
  });

  test("REQ-CLU-002 theme drill-in shows source and cross-theme links", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /access & formulary/i }).first().click();
    await expect(page.getByRole("heading", { name: /access & formulary/i })).toBeVisible();
    await expect(page.getByText(/also sit on other themes/i)).toBeVisible();
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByRole("link").filter({ hasText: /evidence|source|brand|payer/i }).first()).toBeVisible();
  });

  test("REQ-EVA-009 eval tape shows automatic hill-climb results", async ({
    page,
  }) => {
    await page.goto("/evals");
    await expect(page.getByRole("heading", { name: /eval tape/i })).toBeVisible();
    await expect(page.getByText("v1.0-baseline")).toBeVisible();
    await expect(page.getByText(/champion/i).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Run hill-climb sweep/ }),
    ).toHaveCount(0);
  });

  test("REQ-OPS-003 spec tape is view-only", async ({ page }) => {
    await page.goto("/sdlc");
    await expect(page.getByRole("heading", { name: /spec tape/i })).toBeVisible();
    await expect(page.getByText(/view-only/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /problem & solution/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /flow \(process\)/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /flow \(technical\)/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^regression$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^gold set$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^eval protocol$/i })).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });

  test("REQ-CLU-005 insights tab lists every CIR and Unassigned", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /^insights$/i }).click();
    await expect(page.getByRole("heading", { name: /all insights/i })).toBeVisible();
    await expect(page.locator("article").first()).toBeVisible();
    await expect(page.getByText(/unassigned/i).first()).toBeVisible();
    await page.getByRole("link", { name: /unassigned/i }).first().click();
    await expect(page.getByText(/catalog floor|unassigned is empty/i)).toBeVisible();
  });

  test("REQ-CLU-007 catalog explains emerge and split", async ({ page }) => {
    await page.goto("/catalog");
    await expect(page.getByRole("heading", { name: /^catalog$/i, level: 1 })).toBeVisible();
    await expect(page.getByText(/when a theme emerges/i)).toBeVisible();
    await expect(page.getByText(/when a theme splits/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /accept into catalog/i }).first(),
    ).toBeVisible();
  });

  test("REQ-GRF-001 graph explains blends and revelations", async ({ page }) => {
    await page.goto("/graph");
    await expect(page.getByRole("heading", { name: /knowledge graph/i })).toBeVisible();
    await expect(page.getByText(/revealed connections/i)).toBeVisible();
    await expect(page.getByText(/blend|bridge|new implication/i).first()).toBeVisible();
  });
});
