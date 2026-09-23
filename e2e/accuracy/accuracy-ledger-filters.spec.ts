import { expect, test } from "@playwright/test";
import { seedAccuracyFromGold, workspaceUrl } from "../support/accuracy";

/**
 * Operator UX: Ledger chapter/SI filters + workspace plan_label in chrome.
 * Seed without PPTX parse — gold claims are enough.
 */

test.describe("accuracy ledger filters + plan_label chrome", () => {
  test("BGB seed shows IEP chrome and SI filters (Differentiation vs Biomarkers)", async ({
    page,
    request,
  }) => {
    const seed = await seedAccuracyFromGold(request, {
      pack_id: "beone-bgb-58067-prmt5i",
      workspace_name: "E2E Ledger BGB IEP",
      parse_source: false,
    });

    await page.goto(workspaceUrl("/accuracy/ledger", seed.workspace_id));
    await expect(page.getByRole("heading", { name: /^ledger$/i })).toBeVisible();
    await expect(page.getByRole("status", { name: /plan type iep/i })).toBeVisible();
    await expect(page.getByText(/multi-tenant iep stack/i)).toBeVisible();

    const filters = page.getByRole("region", { name: /filters/i });
    await expect(filters.getByText(/strategic imperative/i)).toBeVisible();
    await expect(filters.getByRole("link", { name: /differentiation/i })).toBeVisible();
    await expect(filters.getByRole("link", { name: /biomarkers/i })).toBeVisible();

    await expect(page.getByText("NSCLC_AD_01")).toBeVisible();
    await expect(page.getByText("NSCLC_CE_01")).toBeVisible();

    await filters.getByRole("link", { name: /differentiation/i }).click();
    await expect(page).toHaveURL(/si=differentiation/);
    await expect(page.getByText("NSCLC_CE_01")).toBeVisible();
    await expect(page.getByText("NSCLC_AD_01")).toHaveCount(0);
    await expect(page.locator("table")).toHaveCount(0);
  });

  test("Tisle seed shows IEGP chrome and chapter filters (ESCC vs Lung)", async ({
    page,
    request,
  }) => {
    const seed = await seedAccuracyFromGold(request, {
      pack_id: "beone-tislelizumab-iegp",
      workspace_name: "E2E Ledger Tisle IEGP",
      parse_source: false,
    });

    await page.goto(workspaceUrl("/accuracy/ledger", seed.workspace_id));
    await expect(page.getByRole("status", { name: /plan type iegp/i })).toBeVisible();
    await expect(page.getByText(/multi-tenant iegp stack/i)).toBeVisible();

    const filters = page.getByRole("region", { name: /filters/i });
    await expect(filters.getByText(/^chapter$/i)).toBeVisible();
    await expect(filters.getByRole("link", { name: /^escc/i })).toBeVisible();
    await expect(filters.getByRole("link", { name: /^lung/i })).toBeVisible();

    const esccCue =
      "[1L]: Need for safety and efficacy data supporting tislelizumab (150mg Q2W and 300mg Q4W) + FOLFOX";
    const lungCue = "Need for comparative data (e.g., safety/tolerability data) against competitors";
    await expect(page.getByText(esccCue, { exact: false })).toBeVisible();
    await expect(page.getByText(lungCue, { exact: false })).toBeVisible();

    await filters.getByRole("link", { name: /^escc/i }).click();
    await expect(page).toHaveURL(/chapter=advanced_metastatic_escc/);
    await expect(page.getByText(esccCue, { exact: false })).toBeVisible();
    await expect(page.getByText(lungCue, { exact: false })).toHaveCount(0);
    await expect(page.locator("table")).toHaveCount(0);
  });
});
