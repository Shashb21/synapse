import { expect, test } from "@playwright/test";

test.describe("IEGP user flow", () => {
  test("plan is the IEGP: high / medium / low gaps with tactics", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /iegp/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^high$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^medium$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^low$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /elderly comparative/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /retrospective rwe/i }).first()).toBeVisible();
    await expect(page.getByText(/caregiver burden/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /open gaps and residual/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /accept gap/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /modify gap/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^prioritize$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^addressed$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /pivotal pfs/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /assign tactic/i }).first()).toBeVisible();
  });

  test("needs inbox keeps candidates from becoming gaps", async ({ page }) => {
    await page.goto("/needs");
    await expect(page.getByRole("heading", { name: /evidence needs/i })).toBeVisible();
    await expect(page.getByText(/candidate/i).first()).toBeVisible();
    await expect(page.getByText(/65 and over/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /accept onto gap/i }).first()).toBeVisible();
  });

  test("gap dossier shows dimensional coverage and residual", async ({ page }) => {
    await page.goto("/gaps");
    await page.getByRole("link", { name: /elderly comparative/i }).click();
    await expect(page.getByText(/comparator/i).first()).toBeVisible();
    await expect(page.getByText(/partial/i).first()).toBeVisible();
    await expect(page.getByText(/residual/i).first()).toBeVisible();
    await expect(page.getByText(/never auto-applied/i)).toBeVisible();
  });

  test("registry tactic maps to several gaps", async ({ page }) => {
    await page.goto("/tactics");
    await page.getByRole("link", { name: /prospective velmara registry/i }).click();
    await expect(page.getByText(/sequencing/i).first()).toBeVisible();
    await expect(page.getByText(/hcru/i).first()).toBeVisible();
  });

  test("residuals separate coverage from priority", async ({ page }) => {
    await page.goto("/residuals");
    await expect(page.getByText(/coverage ≠ priority|coverage is not priority/i).first()).toBeVisible();
    await expect(page.getByText(/standard of care in elderly/i).first()).toBeVisible();
    await expect(page.getByText(/does not assign a band|human lock/i).first()).toBeVisible();
  });

  test("roadmap is forward-only", async ({ page }) => {
    await page.goto("/roadmap");
    await expect(page.getByRole("heading", { name: /roadmap/i })).toBeVisible();
    await expect(page.getByText(/completed tactics stay/i).first()).toBeVisible();
    await expect(page.getByText(/natural-history/i)).toHaveCount(0);
  });

  test("eval tape is view-only and engine cannot auto-close", async ({ page }) => {
    await page.goto("/evals");
    await expect(page.getByRole("heading", { name: /eval tape/i })).toBeVisible();
    await expect(page.getByText(/engineMaySetStatus/i)).toBeVisible();
    await expect(page.getByText(/false/i).first()).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });

  test("sources ingest extracts gaps and tactics", async ({ page }) => {
    await page.goto("/sources");
    await expect(page.getByRole("heading", { name: /sources/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /ingest gaps and tactics/i })).toBeVisible();
    await expect(page.getByText(/extracts candidate gaps and tactics/i)).toBeVisible();
  });

  test("spec tape includes IEGP model", async ({ page }) => {
    await page.goto("/sdlc");
    await expect(page.getByRole("link", { name: /iegp model/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /problem & solution/i })).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });
});
