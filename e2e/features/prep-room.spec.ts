import { expect, test } from "@playwright/test";
import { openRail } from "../support/rail";

/**
 * Room is out of the app for now (owner, KAN-52): no Prep/Room switch, the Room URLs
 * return to Prep, and plan context is a Prep place. The mapping table and breakouts are
 * hidden from the nav for now (owner, KAN-56); breakouts return with KAN-57.
 */
test("Room is out for now; plan context is in Prep; mapping table and breakouts are hidden", async ({ page }) => {
  // Several routes compile on first visit in a dev server.
  test.setTimeout(120_000);
  await page.goto("/");
  await openRail(page);
  await expect(page.getByRole("group", { name: /prep or room mode/i })).toHaveCount(0);
  const places = page.getByRole("navigation", { name: "Places" });
  await expect(places.getByRole("link", { name: /^plan context/i })).toHaveAttribute("href", "/setup");
  await expect(places.getByRole("link", { name: /^mapping table/i })).toHaveCount(0);
  await expect(places.getByRole("link", { name: /^breakout groups/i })).toHaveCount(0);

  for (const path of ["/room", "/room/audience", "/presentation"]) {
    await page.goto(path);
    await expect(page).not.toHaveURL(/\/(room|presentation)/);
  }

  await page.goto("/breakouts");
  await expect(page).not.toHaveURL(/\/breakouts/);
  await page.goto("/timeline");
  await expect(page.getByRole("link", { name: /present this plan/i })).toHaveCount(0);
});
