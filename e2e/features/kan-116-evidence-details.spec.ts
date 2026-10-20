import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { firstOpenGap, seedMapped } from "../support/synapse";

test.describe("KAN-116 supporting evidence", () => {
  freshWorkspace({ name: "KAN-116", seed: request => seedMapped(request) });
  test.setTimeout(90_000);

  test("evidence order, keyboard edits, failed settings, narrow layout and full record", async ({ page, request }) => {
    const gap = await firstOpenGap(request);
    await page.goto("/?place=gaps");
    const toggle = page.locator(`tr[data-gap-id="${gap.gap_id}"] [data-testid="gap-row-toggle"]`);
    await expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    await toggle.focus();
    await toggle.press("Enter");
    const pane = page.getByTestId("gap-panel");
    const evidence = pane.getByRole("region", { name: "Constituent needs" });
    await expect(evidence).toBeVisible();
    expect(await pane.evaluate(el => {
      const text = el.textContent!;
      return text.indexOf("Constituent needs") < text.indexOf("Linked tactics");
    })).toBe(true);
    await expect(pane.locator('details[aria-label="History"]')).not.toHaveAttribute("open");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const link = pane.getByRole("link", { name: "Edit gap and mappings", exact: true });
    await link.focus();
    await link.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/gaps/${gap.gap_id}$`));
    await page.route("**/api/plan", async route => {
      if (route.request().postDataJSON()?.action === "set_gap_settings") await route.fulfill({ status: 500, json: { error: "Settings save failed" } });
      else await route.continue();
    });
    const setting = page.getByRole("combobox", { name: "Add a treatment setting" });
    await setting.fill("KAN-116 setting");
    await setting.press("Enter");
    await page.getByRole("textbox", { name: "Reason for settings change (required)" }).fill("Reflect intended treatment setting");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    const error = page.getByRole("alert").filter({ hasText: "Settings save failed" });
    await expect(error).toContainText("Settings save failed");
    await expect(setting).toHaveAttribute("aria-describedby", await error.getAttribute("id") as string);
    await expect(page.getByRole("button", { name: "Remove KAN-116 setting", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry saving settings" })).toBeVisible();
  });
});
