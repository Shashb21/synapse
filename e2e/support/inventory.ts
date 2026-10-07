import { expect, type Page } from "@playwright/test";

/**
 * Opens a row of the Evidence Inventory. Rows start collapsed (owner feedback, KAN-56), and
 * a row shows the gap's number rather than its id, so a gap is found by `data-gap-id`.
 * With no id, the first row is opened.
 */
export async function openInventoryRow(page: Page, gapId?: string) {
  const inventory = page.getByTestId("evidence-inventory");
  const row = gapId ? inventory.locator(`tr[data-gap-id="${gapId}"]`) : inventory.locator("tr[data-gap-id]").first();
  const toggle = row.getByTestId("gap-row-toggle");
  // Click only while closed: a slow retry must not close what the last click opened.
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return row;
}
