import { expect, type Page } from "@playwright/test";

/** Opens the Inventory's shared gap panel without repeating a click through its overlay. */
export async function openInventoryRow(page: Page, gapId?: string) {
  const inventory = page.getByTestId("evidence-inventory");
  const row = gapId ? inventory.locator(`tr[data-gap-id="${gapId}"]`) : inventory.locator("tr[data-gap-id]").first();
  const panel = page.getByTestId("gap-panel");
  const trigger = row.getByTestId("gap-row-toggle");
  await expect(async () => {
    if (!await panel.isVisible()) await trigger.click({ timeout: 5_000 });
    await expect(panel).toBeVisible({ timeout: 1_000 });
    await expect(panel.getByRole("link", { name: "Open full record", exact: true })).toBeVisible();
  }).toPass({ timeout: 30_000 });
  return panel;
}
