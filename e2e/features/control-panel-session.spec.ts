/** Session context stays visible; development tools remain an explicit keyboard choice. */
import { expect, test } from "@playwright/test";
import { signInForSuite, STORAGE_STATE } from "../support/session";

// Sign-out revokes a server-side token, so this file must never inherit the suite's token.
test.use({ storageState: { cookies: [], origins: [] } });

test("session context precedes availability and offers genuine sign-out", async ({ page, playwright, baseURL }, testInfo) => {
  // Keep the same identity/owner context, with a fresh token owned by this journey.
  await signInForSuite(page.request);
  await page.goto("/admin/control");
  const session = page.getByRole("region", { name: "Session", exact: true });
  await expect(session).toContainText("Feature E2E · Medical Affairs");
  await expect(session).toContainText("Signed in · Demo session · Owner");
  await expect(session.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(session.locator("details")).toHaveCount(0);
  expect(await page.locator(".control-panel").evaluate(panel => panel.firstElementChild?.getAttribute("aria-labelledby"))).toBe("session");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath(`session-${width}.png`), fullPage: false });
  }
  await session.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/admin/control");
  await expect(page.getByRole("region", { name: "Session", exact: true })).toContainText("Unsigned");
  // Other specs reload this saved token; sign-out must leave it valid on the server.
  const sharedSession = await playwright.request.newContext({ baseURL, storageState: STORAGE_STATE });
  try {
    const response = await sharedSession.get("/api/workspaces");
    expect(response.status(), "sign-out must preserve the shared suite session").toBe(200);
  } finally {
    await sharedSession.dispose();
  }
});

test.describe("unsigned development tools", () => {
  test("native disclosure works by Tab, Enter and Space; narrow form submits a persistent demo session", async ({ page }, testInfo) => {
    await page.goto("/admin/control");
    const session = page.getByRole("region", { name: "Session", exact: true });
    const disclosure = session.locator("details");
    const summary = session.locator("summary");
    await expect(session).toContainText("Unsigned (demo) · Medical Affairs");
    await expect(disclosure).not.toHaveAttribute("open");
    await expect(session.getByRole("textbox", { name: "Name", exact: true })).toBeHidden();
    // Tab to the native summary rather than scripting the expanded state.
    for (let attempt = 0; attempt < 40 && !(await summary.evaluate(element => element === document.activeElement)); attempt++) {
      await page.keyboard.press("Tab");
    }
    await expect(summary).toBeFocused();
    expect(await summary.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(session.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(disclosure).not.toHaveAttribute("open");
    await page.keyboard.press("Space");
    await expect(disclosure).toHaveAttribute("open", "");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(await session.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
      for (const control of await session.locator("input, select, button").all()) {
        const bounds = await control.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: testInfo.outputPath(`developer-tools-${width}.png`), fullPage: false });
    }
    await session.getByRole("textbox", { name: "Name", exact: true }).fill("KAN196 Demo");
    await session.getByRole("combobox", { name: "Function", exact: true }).selectOption("medical_affairs");
    await session.getByRole("combobox", { name: "Role", exact: true }).selectOption("medical_affairs");
    const response = page.waitForResponse(response => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
    await session.getByRole("button", { name: "Continue as a demo user (development only)", exact: true }).click();
    const result = await response;
    expect(result.ok()).toBe(true);
    expect(result.request().postDataJSON()).toEqual({ demo: true, actor_name: "KAN196 Demo", actor_function: "medical_affairs", role: "medical_affairs" });
    await expect(page).toHaveURL(/\/workspaces$/);
    await page.goto("/admin/control");
    await expect(session).toContainText("KAN196 Demo · Medical Affairs");
    await expect(session).toContainText("Signed in · Demo session");
    await page.reload();
    await expect(session).toContainText("KAN196 Demo · Medical Affairs");
    await expect(session.locator("details")).toHaveCount(0);
  });
});
