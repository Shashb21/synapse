import { expect, type Page } from "@playwright/test";

/**
 * Opens the navigation rail as a person does, by moving the pointer onto it. The rail
 * opens on pointer movement, so retry until the page has hydrated and heard the move.
 */
export async function openRail(page: Page) {
  const rail = page.getByRole("complementary", { name: "Synapse navigation" });
  await expect(async () => {
    await page.mouse.move(900, 400);
    await rail.hover();
    await expect(rail).toHaveAttribute("data-open", "true", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}
