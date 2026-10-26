import { expect, test } from "@playwright/test";
import { openRail } from "../support/rail";
import { freshWorkspace } from "../support/session";

test.describe("KAN-160 mobile navigation", () => {
  freshWorkspace({ name: "KAN-160 mobile navigation" });
  test.use({ viewport: { width: 390, height: 844 } });

  test("More expands and collapses without closing the sheet, then Needs closes it", async ({ page }) => {
    await page.goto("/?place=gaps");
    await page.getByRole("button", { name: "Open places" }).click();
    const sheet = page.getByRole("dialog", { name: "Synapse IEGP" });
    const more = sheet.locator("summary");
    const needs = sheet.getByRole("link", { name: "Needs", exact: true });
    const restart = sheet.getByRole("button", { name: "Restart walkthrough" });

    await more.click();
    await expect(sheet).toBeVisible();
    await expect(needs).toBeVisible();
    await expect(restart).toBeVisible();
    await more.click();
    await expect(sheet).toBeVisible();
    await expect(needs).toBeHidden();
    await expect(restart).toBeHidden();
    await more.click();
    await needs.click();
    await expect(page).toHaveURL(/\/needs$/, { timeout: 15_000 });
    await expect(sheet).toBeHidden();
  });

  for (const key of ["Enter", "Space"]) {
    test(`keyboard ${key} toggles More and Enter selects Needs`, async ({ page }) => {
      await page.goto("/?place=gaps");
      await page.getByRole("button", { name: "Open places" }).click();
      const sheet = page.getByRole("dialog", { name: "Synapse IEGP" });
      const more = sheet.locator("summary");
      const needs = sheet.getByRole("link", { name: "Needs", exact: true });
      await more.focus();
      await page.keyboard.press(key);
      await expect(sheet).toBeVisible();
      await expect(needs).toBeVisible();
      await page.keyboard.press(key);
      await expect(sheet).toBeVisible();
      await expect(needs).toBeHidden();
      await page.keyboard.press(key);
      await page.keyboard.press("Tab");
      await expect(needs).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/needs$/);
      await expect(sheet).toBeHidden();
    });
  }

  for (const destination of [
    { label: /^Plan context/, url: /\/setup$/ },
    { label: /^Upload/, url: /\/\?place=upload$/ },
    { label: /^Evidence Inventory/, url: /\/\?place=gaps$/ },
    { label: /^Prioritization Matrix/, url: /\/\?place=plan$/ },
    { label: /^Tactic Ideation/, url: /\/\?place=tactics$/ },
    { label: /^Gantt Timeline/, url: /\/timeline$/ },
  ]) {
    test(`${destination.label.source} selection closes the sheet, including the current page`, async ({ page }) => {
      await page.goto("/?place=gaps");
      await page.getByRole("button", { name: "Open places" }).click();
      const sheet = page.getByRole("dialog", { name: "Synapse IEGP" });
      await sheet.getByRole("link", { name: destination.label }).click();
      await expect(page).toHaveURL(destination.url);
      await expect(sheet).toBeHidden();
    });
  }

  test("selecting Needs while already on Needs closes the sheet", async ({ page }) => {
    await page.goto("/needs");
    await page.getByRole("button", { name: "Open places" }).click();
    const sheet = page.getByRole("dialog", { name: "Synapse IEGP" });
    await sheet.locator("summary").click();
    await sheet.getByRole("link", { name: "Needs", exact: true }).click();
    await expect(page).toHaveURL(/\/needs$/);
    await expect(sheet).toBeHidden();
  });

  test("theme controls keep the sheet open and Restart walkthrough remains usable", async ({ page }) => {
    await page.goto("/?place=gaps");
    await page.getByRole("button", { name: "Open places" }).click();
    const sheet = page.getByRole("dialog", { name: "Synapse IEGP" });
    const theme = sheet.getByRole("switch");
    const wasDark = await theme.getAttribute("aria-checked");
    await theme.click();
    await expect(sheet).toBeVisible();
    await expect(theme).toHaveAttribute("aria-checked", wasDark === "true" ? "false" : "true");
    await sheet.locator("summary").click();
    const restarted = page.waitForResponse(response => response.url().endsWith("/api/walkthrough") && response.request().method() === "POST");
    await sheet.getByRole("button", { name: "Restart walkthrough" }).focus();
    await page.keyboard.press("Enter");
    expect((await restarted).ok()).toBe(true);
    await expect(page).toHaveURL(/\/\?place=gaps$/);
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("walkthrough")).toBeVisible();
    const closeWalkthrough = page.getByRole("button", { name: "Close walkthrough" });
    await closeWalkthrough.focus();
    await expect(closeWalkthrough).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("walkthrough")).toBeHidden();
  });

  test("desktop More keeps Needs and Restart walkthrough usable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto("/?place=gaps");
    await openRail(page);
    const rail = page.getByRole("complementary", { name: "Synapse navigation" });
    await rail.locator("summary").click();
    await expect(rail.getByRole("button", { name: "Restart walkthrough" })).toBeVisible();
    await rail.getByRole("link", { name: "Needs", exact: true }).click();
    await expect(page).toHaveURL(/\/needs$/);
  });
});
