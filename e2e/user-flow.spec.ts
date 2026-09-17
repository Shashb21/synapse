import { expect, test } from "@playwright/test";

async function resetBlank(page: import("@playwright/test").Page) {
  const res = await page.request.post("/api/iegp", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({
      action: "reset",
      actor_name: "E2E",
      actor_function: "evidence_lead",
    }),
  });
  expect(res.ok()).toBeTruthy();
}

test.describe.configure({ mode: "serial" });

test.describe("blank IEGP demo workspace", () => {
  test.beforeEach(async ({ page }) => {
    await resetBlank(page);
  });

  test("plan starts empty and points at demo sources", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /iegp/i })).toBeVisible();
    await expect(page.getByText(/blank workspace/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^high$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^medium$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^low$/i })).toBeVisible();
    await expect(page.getByText(/no extracted gaps waiting/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /ingest a demo source/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /reset to blank slate/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /accept gap/i })).toHaveCount(0);
  });

  test("sources lists uningested demo files and a file upload", async ({ page }) => {
    await page.goto("/sources");
    await expect(page.getByRole("heading", { name: /demo source files/i })).toBeVisible();
    await expect(page.getByText(/01-heor-stakeholder-interview.txt/)).toBeVisible();
    await expect(page.getByText(/not ingested/i).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^download$/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /ingest this file/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /ingest gaps and tactics/i })).toBeVisible();
    await expect(page.getByText(/none yet/i)).toBeVisible();
  });

  test("ingesting a demo file extracts gaps and tactics onto the plan", async ({ page }) => {
    await page.goto("/sources");
    await page.getByRole("button", { name: /ingest this file/i }).first().click();
    await page.getByPlaceholder("A. Rao").fill("A. Rao");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await expect(page.getByText(/ingested/i).first()).toBeVisible();
    await page.goto("/");
    await expect(page.getByRole("button", { name: /accept gap/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /modify gap/i }).first()).toBeVisible();
    await expect(page.getByText(/economic burden|comparative effectiveness/i).first()).toBeVisible();
    await page.goto("/tactics");
    await expect(page.getByText(/chart review/i).first()).toBeVisible();
  });

  test("needs stay empty until a source is ingested", async ({ page }) => {
    await page.goto("/needs");
    await expect(page.getByRole("heading", { name: /evidence needs/i })).toBeVisible();
    await expect(page.getByText(/empty\. ingest a demo source/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /accept onto gap/i })).toHaveCount(0);
  });

  test("gaps, residuals, and roadmap are empty on a blank slate", async ({ page }) => {
    await page.goto("/gaps");
    await expect(page.getByText(/no gaps yet/i)).toBeVisible();
    await page.goto("/residuals");
    await expect(page.getByText(/no residuals yet/i)).toBeVisible();
    await page.goto("/roadmap");
    await expect(page.getByText(/completed tactics stay/i).first()).toBeVisible();
    await expect(page.getByText(/no forward tactics yet/i)).toBeVisible();
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
