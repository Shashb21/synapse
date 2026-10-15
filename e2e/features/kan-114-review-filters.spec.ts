import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { seedMapped } from "../support/synapse";

test.describe("KAN-114 independent inventory filters", () => {
  freshWorkspace({ name: "KAN-114", seed: (request) => seedMapped(request) });
  test("combines filters, preserves them on reload and resets an empty search", async ({ page }) => {
    await page.goto("/?place=gaps");
    const attention = page.getByRole("button", { name: /^Needs attention/ });
    await expect(attention).toHaveAttribute("aria-pressed", "false");
    await attention.click();
    await page.getByRole("button", { name: /^Open \(/ }).click();
    await page.reload();
    await expect(attention).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /^Open \(/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("searchbox", { name: "Search gaps" }).fill("no-matching-gap-kan-114");
    await expect(page.getByText("No gaps match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Reset filters", exact: true }).click();
    await expect(attention).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("evidence-inventory").locator("tr[data-gap-id]").first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Review state", exact: true })).toBeVisible();
  });
});
