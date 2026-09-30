import { expect, type Page } from "@playwright/test";

/**
 * A gap's card on Tactic Ideation, opened. Cards start collapsed (owner feedback, KAN-56),
 * and the card shows the gap's number rather than its id, so it is found by `data-gap-id`.
 */
export async function openIdeationCard(page: Page, gapId: string) {
  const card = page.locator(`[data-testid="ideation-gap"][data-gap-id="${gapId}"]`);
  const toggle = card.getByTestId("ideation-gap-toggle");
  // Click only while closed: a slow retry must not close what the last click opened.
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click({ timeout: 5_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return card;
}
