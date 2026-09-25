import { expect, test } from "@playwright/test";

/** Prep ↔ Room: Room is one click from Prep, and Esc brings you back. */
test("Room opens the room view and Esc brings you back to Prep", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("group", { name: /prep or room mode/i }).first();
  await expect(toggle.getByText("Prep")).toHaveAttribute("aria-current", "true");
  await toggle.getByRole("link", { name: "Room" }).click();
  await expect(page).toHaveURL(/\/room(\?.*)?$/, { timeout: 60_000 });
  // Room never renders the accuracy app.
  expect(page.url()).not.toContain("/accuracy");

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/(\?.*)?$/, { timeout: 60_000 });
  await expect(page.getByRole("group", { name: /prep or room mode/i }).first().getByText("Prep")).toHaveAttribute(
    "aria-current",
    "true",
  );
});
