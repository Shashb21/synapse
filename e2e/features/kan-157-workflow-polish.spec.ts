import { expect, test, type Page } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction } from "../support/synapse";

/** Authenticated workflow evidence uses an owned disposable workspace. */
test.describe("KAN-157 authenticated workflow", () => {
  freshWorkspace({ name: "KAN-157 workflow" });

  async function capture(page: Page, name: string) {
    await page.waitForLoadState("networkidle");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/private/tmp/kan157-${name}.png`, fullPage: true });
    if (name === "inventory-390") await page.screenshot({path: "/private/tmp/kan157-next-action-390.png"});
  }

  test("native setup choices and upload expose keyboard focus", async ({page, request}) => {
    await iegpAction(request, {action: "reset"});
    await page.setViewportSize({width: 390, height: 844});
    await page.goto("/setup");
    await page.getByRole("button", {name: "Asset", exact: true}).click();
    const group = page.getByRole("radiogroup", {name: "Lifecycle stage"});
    const radios = group.getByRole("radio");
    await radios.first().focus();
    await page.keyboard.press("Space");
    await expect(radios.first()).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(radios.nth(1)).toBeChecked();
    await expect(radios.nth(1)).toBeFocused();
    expect(await radios.nth(1).evaluate(input => getComputedStyle(input.nextElementSibling!).boxShadow)).not.toBe("none");
    await page.goto("/?place=upload");
    const file = page.getByLabel("Choose file", {exact: true});
    await file.focus();
    await expect(file).toBeFocused();
    const label = page.locator("label").filter({hasText: "Choose file"});
    expect(await label.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
    await page.screenshot({path: "/private/tmp/kan157-upload-focus-390.png", fullPage: true});
  });

  for (const width of [390, 1280]) {
    test(`empty and blocked stages remain readable at ${width}px`, async ({ page, request }) => {
      await iegpAction(request, { action: "reset" });
      await page.setViewportSize({ width, height: 844 });
      for (const [name, url] of [
        ["empty-context", "/setup"],
        ["empty-inventory", "/?place=gaps"],
        ["blocked-priority", "/?place=plan"],
        ["blocked-tactics", "/?place=tactics"],
        ["empty-timeline", "/timeline"],
      ]) {
        await page.goto(url!);
        await expect(page.getByRole("main")).toBeVisible();
        await capture(page, `${name}-${width}`);
      }
      if (width === 390) {
        const menu = page.getByRole("button", { name: "Open places" });
        await menu.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("navigation", { name: "All places" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(menu).toBeFocused();
      }
    });

    test(`populated stages and readiness handoff at ${width}px`, async ({ page, request }) => {
      await iegpAction(request, { action: "load_demo" });
      await page.setViewportSize({ width, height: 844 });
      for (const [name, url] of [
        ["context", "/setup"],
        ["inventory", "/?place=gaps"],
        ["priority", "/?place=plan"],
        ["tactics", "/?place=tactics"],
        ["timeline", "/timeline"],
      ]) {
        await page.goto(url!);
        await expect(page.getByRole("region", { name: "Prep readiness" })).toBeVisible();
        await capture(page, `${name}-${width}`);
        if (name === "timeline") {
          const checklist = page.getByTestId("final-save-checklist");
          await expect(checklist).not.toHaveAttribute("open", "");
          const summary = checklist.locator("summary");
          await summary.focus();
          await page.keyboard.press("Enter");
          await expect(checklist).toHaveAttribute("open", "");
          await expect(checklist.getByTestId("final-gap-blocker").first()).toBeVisible();
          await page.keyboard.press("Enter");
          await expect(checklist).not.toHaveAttribute("open", "");
        }
      }
      const readiness = page.getByRole("region", { name: "Prep readiness" });
      const next = readiness.getByRole("link").first();
      await expect(next).toBeVisible();
      await next.focus();
      const href = await next.getAttribute("href");
      expect(href).toBeTruthy();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(href!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }
});
