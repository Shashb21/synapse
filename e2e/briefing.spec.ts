import { expect, test } from "@playwright/test";

test.describe("REQ-REG-002 end-to-end regression", () => {
  test("REQ-KNO-004 monitor lists themes with situation briefs", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("SYNAPSE").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "THEME MONITOR" })).toBeVisible();
    await expect(page.getByRole("link", { name: /ACCESS & FORMULARY/ })).toBeVisible();
    await expect(page.getByText(/AS OF/)).toBeVisible();
  });

  test("REQ-CLU-002 theme drill-in shows source and cross-theme links", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /ACCESS & FORMULARY/ }).first().click();
    await expect(page.getByText("ALSO IN")).toBeVisible();
    await expect(page.getByText("SOURCE")).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("REQ-EVA-009 eval tape shows automatic hill-climb results", async ({
    page,
  }) => {
    await page.goto("/evals");
    await expect(page.getByRole("heading", { name: "EVAL TAPE" })).toBeVisible();
    await expect(page.getByText("v1.0-baseline")).toBeVisible();
    await expect(page.getByText(/CHAMPION/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Run hill-climb sweep/ }),
    ).toHaveCount(0);
  });
});
