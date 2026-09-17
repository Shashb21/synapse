import { expect, test } from "@playwright/test";

test.describe("IEGP user flow", () => {
  test("plan monitor shows Velmara and gap inventory", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /integrated evidence plan/i })).toBeVisible();
    await expect(page.getByText(/velmara/i).first()).toBeVisible();
    await expect(page.getByText(/elderly comparative/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^needs$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^gaps$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^roadmap$/i })).toBeVisible();
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
    await expect(page.getByText(/locked medium/i).first()).toBeVisible();
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

  test("spec tape includes IEGP model", async ({ page }) => {
    await page.goto("/sdlc");
    await expect(page.getByRole("link", { name: /iegp model/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /problem & solution/i })).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });
});
