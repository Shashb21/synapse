import { expect, test } from "@playwright/test";

test.describe("REQ-REG-002 end-to-end regression", () => {
  test("REQ-KNO-004 briefing shows known, unknown, and opportunities", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Velmara" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What we know" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "What we don’t know" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Opportunities to close gaps" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Themes" })).toBeVisible();
  });

  test("REQ-CLU-002 theme pages link insights without duplicating CIR ids in the briefing", async ({
    page,
  }) => {
    await page.goto("/");
    const knownCards = page.locator("section").filter({ hasText: "What we know" }).locator("article");
    const count = await knownCards.count();
    expect(count).toBeGreaterThan(3);
    await page.getByRole("link", { name: /Access & formulary/ }).first().click();
    await expect(page.getByText(/linked insights/)).toBeVisible();
  });

  test("REQ-EVA-009 eval lab scores prompt versions", async ({ page }) => {
    await page.goto("/evals");
    await expect(page.getByRole("heading", { name: "Eval lab" })).toBeVisible();
    await expect(page.getByText("v1.0-baseline")).toBeVisible();
    await page.getByRole("button", { name: /Run hill-climb sweep/ }).click();
    await expect(page.getByText(/Champion/)).toBeVisible();
  });
});
