import { expect, test } from "@playwright/test";

// KAN-27: the actor is the signed-in person, so confirm dialogs ask for no name or function.
test("lock dialog records the signed-in person, with no name or function fields", async ({ page }) => {
  const reset = await page.request.post("/api/iegp", { data: { action: "reset" } });
  expect(reset.ok()).toBeTruthy();
  await page.goto("/?place=upload");
  await page.getByRole("button", { name: /ingest this file/i }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/recorded in the audit trail under your name/i)).toBeVisible();
  await expect(dialog.getByText(/no login/i)).toHaveCount(0);
  await expect(dialog.getByPlaceholder("Your name")).toHaveCount(0);
  await expect(dialog.getByLabel(/^function$/i)).toHaveCount(0);
});
