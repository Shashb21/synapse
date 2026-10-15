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
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await toggle.press("Enter");
    const pane = page.locator(`article[data-gap-id="${gap.gap_id}"]`);
    const evidence = pane.getByRole("region", { name: "Sources and supporting statements" });
    await expect(evidence).toBeVisible();
    expect(await pane.evaluate(el => {
      const text = el.textContent!;
      return text.indexOf("Sources and supporting statements") < text.indexOf("Review tactic mappings") && text.indexOf("Review tactic mappings") < text.indexOf("Edit gap details");
    })).toBe(true);
    const edits = pane.locator("summary");
    await expect(pane.locator("details")).not.toHaveAttribute("open");
    await edits.focus();
    expect(await edits.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await edits.press("Enter");
    await page.route("**/api/plan", async route => {
      if (route.request().postDataJSON()?.action === "set_gap_settings") await route.fulfill({ status: 500, json: { error: "Settings save failed" } });
      else await route.continue();
    });
    const setting = pane.getByRole("combobox", { name: "Add a treatment setting" });
    await setting.fill("KAN-116 setting");
    await setting.press("Enter");
    const error = pane.getByRole("alert");
    await expect(error).toContainText("Settings save failed");
    await expect(setting).toHaveAttribute("aria-describedby", await error.getAttribute("id") as string);
    await expect(pane.getByRole("button", { name: "Remove KAN-116 setting", exact: true })).toBeVisible();
    await expect(pane.getByRole("button", { name: "Retry saving settings" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const link = evidence.getByRole("link", { name: "Open full gap and evidence record" });
    await link.scrollIntoViewIfNeeded();
    await link.focus();
    await link.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/gaps/${gap.gap_id}$`));
  });
});
