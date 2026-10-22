import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction, resetWorkspace, runStage, validateBandHigh } from "../support/synapse";
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
test("keyboard pin reserves space and persists through reload; unpin restores transient reveal", async ({ page }, testInfo) => {
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
  await page.screenshot({ path: testInfo.outputPath("kan155-pinned-desktop.png"), fullPage: true });
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
test.describe("Long gap titles", () => {
  freshWorkspace({ name: "KAN-155 long titles", seed: async request => {
    await resetWorkspace(request);
    const created = await iegpAction(request, { action: "create_gap", name: longTitle, statement: "Comparative outcomes are missing", domain: "comparative_effectiveness" });
    const gapId = String(created.id);
    await iegpAction(request, { action: "validate_gap", gap_id: gapId });
    await validateBandHigh(request, gapId, "The comparison blocks the committee decision");
    await iegpAction(request, { action: "complete_wizard", note: "Inventory reviewed" });
    await iegpAction(request, { action: "unlock_tactics", note: "Priorities confirmed" });
    await runStage(request, "S9", { gap_ids: [gapId], per_gap: 1 });
  } });
  for (const [label, width] of [["desktop", 1280], ["mobile", 390], ["200-percent-equivalent", 640]] as const) {
    test(`long titles wrap with usable navigation at ${label}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 820 });
      await page.goto("/?place=tactics");
      const name = page.getByTestId("ideation-gap-toggle").first().getByText(longTitle, { exact: true });
      await expect(name).toBeVisible();
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
      await page.screenshot({ path: testInfo.outputPath(`kan155-long-title-${label}.png`), fullPage: true });
    });
  }

});
