import { expect, test } from "@playwright/test";
import { openRail } from "../support/rail";

// KAN-8: the rail opens on hover or keyboard focus, and never stays open over the page
// after a mouse click (it used to keep focus-within and swallow clicks under it).
test("the rail collapses after a click once the pointer leaves, and opens for keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?place=gaps");
  const rail = page.getByRole("complementary", { name: "Synapse navigation" });
  const width = async () => (await rail.boundingBox())!.width;

  await openRail(page);
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

// A pin reserves space; temporary reveal must not become a saved pin.
test("keyboard pin reserves space and persists through reload; unpin restores transient reveal", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?place=gaps");
  const rail = page.getByRole("complementary", { name: "Synapse navigation" });
  const slot = page.locator("[data-rail-slot]");
  const width = async () => (await slot.boundingBox())!.width;
  const pin = rail.getByRole("button", { name: "Pin navigation", exact: true });
  await expect.poll(width).toBe(52);
  await pin.focus();
  await page.keyboard.press("Enter");
  await expect(rail.getByRole("button", { name: "Unpin navigation", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(width).toBe(220);
  await page.mouse.move(900, 400);
  await page.getByRole("main").click({ position: { x: 500, y: 300 } });
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(220);
  await page.reload();
  const unpin = rail.getByRole("button", { name: "Unpin navigation", exact: true });
  await expect(unpin).toHaveAttribute("aria-pressed", "true");
  await expect.poll(width).toBe(220);
  await page.screenshot({ path: "/private/tmp/kan155-pinned-desktop.png", fullPage: true });
  await unpin.focus();
  await page.keyboard.press("Space");
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect.poll(width).toBe(52);
  // Keyboard focus reveals labels without reserving the expanded width.
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(220);
  await page.getByRole("main").click({ position: { x: 500, y: 300 } });
  await page.mouse.move(900, 400);
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(52);
  await openRail(page);
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(220);
  await expect.poll(width).toBe(52);
  await page.mouse.move(900, 400);
  await expect.poll(async () => (await rail.boundingBox())!.width).toBe(52);
  await page.reload();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect.poll(width).toBe(52);
});

const longTitle = "Long-term comparative effectiveness and patient-reported outcomes in adults with multiple prior therapies across routine clinical care settings";
for (const [label, width] of [["desktop", 1280], ["mobile", 390], ["200-percent-equivalent", 640]] as const) {
  test(`long titles wrap with usable navigation at ${label}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto("/?place=tactics");
    // Substitute realistic long copy in the rendered name element so layout
    // coverage does not depend on the seed data's incidental title lengths.
    const name = page.getByTestId("ideation-gap-toggle").first().locator("span").nth(2);
    await expect(name).toBeVisible();
    await name.evaluate((element, title) => { element.textContent = title; }, longTitle);
    const titleStyle = await name.evaluate(element => {
      const style = getComputedStyle(element);
      return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight), fits: element.scrollWidth <= element.clientWidth };
    });
    expect(titleStyle.whiteSpace).not.toBe("nowrap");
    expect(titleStyle.textOverflow).not.toBe("ellipsis");
    expect(titleStyle.height).toBeGreaterThan(titleStyle.lineHeight);
    expect(titleStyle.fits).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width < 768) {
      await expect(page.getByRole("button", { name: "Open places" })).toBeVisible();
      await page.getByRole("button", { name: "Open places" }).click();
      await expect(page.getByRole("navigation", { name: "All places" })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await page.screenshot({ path: `/private/tmp/kan155-long-title-${label}.png`, fullPage: true });
  });
}
