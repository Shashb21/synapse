import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, seedMapped } from "../support/synapse";

test.describe.configure({ mode: "serial" });

// KAN-49: the design's gap details: impacted stakeholders, geography, regional nuances, notes.
test.describe("gap details", () => {
  freshWorkspace({ name: "KAN-49", seed: (request) => seedMapped(request) });

  test.setTimeout(90_000);

  test("edited on the gap page, shown there and on the Evidence Inventory row", async ({ page, request }) => {
    const gap = await firstOpenGap(request);
    await page.goto(`/gaps/${gap.gap_id}`);
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await page.getByRole("button", { name: /^(add|edit) details$/i }).click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await dialog.getByLabel(/impacted stakeholders/i).fill("Payers, HTA bodies, payers");
    await dialog.getByLabel(/^geography$/i).fill("US, EU5");
    await dialog.getByLabel(/regional nuances/i).fill("Germany: G-BA wants a head-to-head comparator.");
    await dialog.getByRole("button", { name: /^save details$/i }).click();
    await expect(dialog).toBeHidden();

    const details = page.getByTestId("gap-metadata");
    await expect(details).toContainText("Payers");
    await expect(details).toContainText("HTA bodies");
    await expect(details).toContainText("US, EU5");
    await expect(details).toContainText("G-BA wants a head-to-head comparator");
    // Case-insensitive duplicates collapse to the first spelling.
    await expect(details.getByText("payers", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^edit details$/i })).toBeVisible();

    await page.goto("/?place=gaps");
    const inventory = page.getByTestId("evidence-inventory");
    const row = inventory.locator("tr").filter({ has: page.getByRole("cell", { name: gap.gap_id, exact: true }) });
    const toggle = row.getByTestId("gap-row-toggle");
    await expect(async () => {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click({ timeout: 5_000 });
      await expect(inventory.getByTestId("gap-metadata")).toContainText("US, EU5", { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  });
});
