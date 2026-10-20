import { expect, test } from "@playwright/test";
import { iegpAction } from "../support/synapse";

/**
 * Create tactic on Tactics takes a status, so an existing real study can be
 * entered as planned, ongoing or completed, and it shows no stray note field.
 */
test.describe.configure({ mode: "serial" });

test.describe("Create tactic", () => {
  test.beforeAll(async ({ request }) => {
    await iegpAction(request, { action: "load_demo" });
  });

  test("records an ongoing study with its dates, and asks for no note", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/tactics");
    const trigger = page.getByRole("button", { name: "Create tactic" });
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await trigger.click();
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    // The Addressed-override note no longer rides along in every dialog.
    await expect(dialog.getByText(/Note \(required to override Addressed\)/)).toHaveCount(0);
    await expect(dialog.locator('textarea[name="note"]')).toHaveCount(0);

    const status = dialog.getByLabel("Status");
    await expect(status).toHaveValue("proposed");
    await dialog.getByPlaceholder("Tactic name").fill("E2E ongoing registry");
    // No type is assumed: the person picks it.
    await expect(dialog.getByLabel("Tactic type")).toHaveValue("");
    await dialog.getByLabel("Tactic type").selectOption("registry");
    await dialog.getByPlaceholder("Evidence question").fill("What is 12-month persistence in routine care?");
    await status.selectOption("ongoing");
    await dialog.getByLabel("Start date (optional)").fill("2026-02-01");
    await dialog.getByLabel("Evidence available (optional)").fill("2027-09-30");
    await dialog.getByRole("button", { name: "Add to library" }).click();
    await expect(dialog).toBeHidden();

    // The library is a collapsed panel on Tactic Ideation (KAN-8): open it to find the new tactic.
    const library = page.getByRole("region", { name: /^tactic library$/i });
    await library.getByRole("button", { name: /tactic library/i }).click();
    // "Edit" opens the side panel (KAN-50); the panel links to the full tactic page.
    await library.getByRole("button", { name: /edit E2E ongoing registry/i }).first().click();
    await page.getByTestId("tactic-panel").getByRole("link", { name: "Open full record", exact: true }).click();
    await expect(page).toHaveURL(/\/tactics\/TAC-/);
    await expect(page.getByText("ongoing", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("2026-02-01").first()).toBeVisible();
    // The consolidated editor keeps the full record's month-only and clearing capability.
    const form = page.getByRole("form", { name: "Edit E2E ongoing registry", exact: true });
    await page.getByRole("button", { name: "Edit tactic", exact: true }).click();
    await form.getByLabel("Start date", { exact: true }).fill("2026-03");
    await form.getByLabel(/why\? \(required\)/i).fill("Plan the start month before the exact day is known");
    await form.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(form).toBeHidden();
    await expect(page.getByRole("definition").filter({ hasText: "2026-03" })).toBeVisible();
    await page.getByRole("button", { name: "Edit tactic", exact: true }).click();
    await form.getByLabel("Start date", { exact: true }).fill("");
    await form.getByLabel(/why\? \(required\)/i).fill("The start month is no longer confirmed");
    await form.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(form).toBeHidden();
    await expect(page.getByRole("term").filter({ hasText: /^Start date$/ }).locator("..")).toHaveText("Start date—");
  });
});
