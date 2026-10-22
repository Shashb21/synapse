import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { seedMapped } from "../support/synapse";

test.describe("KAN-114 independent inventory filters", () => {
  freshWorkspace({ name: "KAN-114", seed: (request) => seedMapped(request) });
  test("combines filters, preserves them on reload and resets an empty search", async ({ page }) => {
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /hydration|hydrated|server rendered HTML/i.test(message.text())) {
        hydrationErrors.push(message.text());
      }
    });
    await page.goto("/?place=gaps");
    // Screenshot tooling must not mutate input styles while React attaches to server HTML.
    await page.getByRole("searchbox", { name: "Search gaps" }).waitFor();
    await page.screenshot({ caret: "initial" });
    const attention = page.getByRole("button", { name: /^Needs attention/ });
    await expect(attention).toHaveAttribute("aria-pressed", "false");
    await attention.click();
    const filters = page.locator("details[data-inventory-filters]");
    await expect(filters).not.toHaveAttribute("open");
    await filters.locator("summary").click();
    await page.getByRole("button", { name: /^Open \(/ }).click();
    await page.reload();
    await expect(attention).toHaveAttribute("aria-pressed", "true");
    await expect(filters).not.toHaveAttribute("open");
    await expect(page.locator('[aria-label="Active secondary filters"]')).toContainText("Open");
    await filters.locator("summary").click();
    await expect(page.getByRole("button", { name: /^Open \(/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("searchbox", { name: "Search gaps" }).fill("no-matching-gap-kan-114");
    await expect(page.getByText("No gaps match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Reset filters", exact: true }).click();
    await expect(attention).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("evidence-inventory").locator("tr[data-gap-id]").first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Review state and next action", exact: true })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search gaps" })).not.toHaveAttribute("style", /caret-color/);
    expect(hydrationErrors).toEqual([]);
  });
});
