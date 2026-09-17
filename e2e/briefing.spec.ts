import { expect, test } from "@playwright/test";

test("lock dialog records a named actor without login", async ({ page }) => {
  await page.request.post("/api/iegp", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({
      action: "reset",
      actor_name: "E2E",
      actor_function: "evidence_lead",
    }),
  });
  await page.goto("/");
  await page.getByRole("button", { name: /ingest this file/i }).first().click();
  await expect(page.getByText(/type your name and function/i)).toBeVisible();
  await expect(page.getByPlaceholder("Your name")).toHaveValue("");
  await expect(page.getByText(/empty until you type/i)).toBeVisible();
  await expect(page.getByLabel(/^function$/i)).toHaveValue("evidence_lead");
});
