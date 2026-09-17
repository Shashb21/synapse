import { expect, test } from "@playwright/test";

test("lock dialog records a named actor without login", async ({ page }) => {
  await page.goto("/needs");
  await page.getByRole("button", { name: /accept onto gap/i }).first().click();
  await expect(page.getByText(/type your name and function/i)).toBeVisible();
  await expect(page.getByPlaceholder("A. Rao")).toBeVisible();
});
