import { expect, test } from "@playwright/test";

// KAN-8: the rail opens on hover or keyboard focus, and never stays open over the page
// after a mouse click (it used to keep focus-within and swallow clicks under it).
test("the rail collapses after a click once the pointer leaves, and opens for keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?place=gaps");
  const rail = page.getByRole("complementary", { name: "Synapse navigation" });
  const width = async () => (await rail.boundingBox())!.width;

  await rail.hover();
  await expect.poll(width).toBeGreaterThan(200);
  await rail.getByRole("link", { name: /^tactic ideation/i }).click();
  await expect(page).toHaveURL(/place=tactics/);
  await page.mouse.move(900, 400);
  await expect.poll(width).toBeLessThan(60);

  // Keyboard users still get the labels.
  await rail.getByRole("link", { name: /^evidence inventory/i }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect.poll(width).toBeGreaterThan(200);
});
