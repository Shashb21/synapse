import { expect, test } from "@playwright/test";

/** Prep ↔ Room: whichever mode you are in, the other is one click away. */
test("Room opens the workshop and Prep brings you back", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("group", { name: /prep or room mode/i }).first();
  await toggle.getByRole("link", { name: "Room" }).click();
  await expect(page).toHaveURL(/\/accuracy\/workshop/);

  const roomToggle = page.getByRole("group", { name: /prep or room mode/i }).first();
  await expect(roomToggle.getByText("Room")).toHaveAttribute("aria-current", "true");
  await roomToggle.getByRole("link", { name: "Prep" }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByRole("group", { name: /prep or room mode/i }).first().getByText("Prep")).toHaveAttribute(
    "aria-current",
    "true",
  );
});
