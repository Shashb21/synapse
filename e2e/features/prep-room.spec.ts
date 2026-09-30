import { expect, test } from "@playwright/test";
import { openRail } from "../support/rail";

/**
 * Room is out of the app for now (owner, KAN-52): no Prep/Room switch, the Room URLs
 * return to Prep, and plan context, the mapping table and breakouts are Prep places.
 */
test("Room is out for now; its context, mapping table and breakouts are in Prep", async ({ page }) => {
  // Several routes compile on first visit in a dev server.
  test.setTimeout(120_000);
  await page.goto("/");
  await openRail(page);
  await expect(page.getByRole("group", { name: /prep or room mode/i })).toHaveCount(0);
  const places = page.getByRole("navigation", { name: "Places" });
  for (const [name, href] of [
    [/^plan context/i, "/setup"],
    [/^mapping table/i, "/mappings"],
    [/^breakout groups/i, "/breakouts"],
  ] as const) {
    await expect(places.getByRole("link", { name })).toHaveAttribute("href", href);
  }

  for (const path of ["/room", "/room/audience", "/presentation"]) {
    await page.goto(path);
    await expect(page).not.toHaveURL(/\/(room|presentation)/);
  }

  await page.goto("/breakouts");
  await expect(page.getByRole("heading", { name: "Breakout groups" })).toBeVisible();
  await expect(page.getByRole("link", { name: /room presenter view|switch to presentation/i })).toHaveCount(0);
  await page.goto("/timeline");
  await expect(page.getByRole("link", { name: /present this plan/i })).toHaveCount(0);
});
