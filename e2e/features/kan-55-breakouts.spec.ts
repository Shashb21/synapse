import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { seedMapped } from "../support/synapse";

test.describe.configure({ mode: "serial", timeout: 120_000 });

// KAN-55: clearer breakout actions; assign gaps one by one, by filter, or a whole theme at once.
// Breakouts are hidden from the app for now (owner, KAN-56); the workflow comes back with KAN-57.
test.describe.skip("breakout groups", () => {
  freshWorkspace({ name: "KAN-55", seed: (request) => seedMapped(request) });

  test("groups every gap by domain in one step", async ({ page }) => {
    await page.goto("/breakouts");
    const overview = page.getByTestId("breakouts-overview");
    await expect(overview.getByText("No breakout groups yet.")).toBeVisible();
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await overview.getByRole("button", { name: /group gaps by theme/i }).click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await dialog.getByRole("radio", { name: "Evidence domain" }).click();
    const preview = dialog.getByRole("list", { name: "Groups to create" }).getByRole("listitem");
    const count = await preview.count();
    expect(count).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: new RegExp(`^Create ${count} group`) }).click();
    await expect(dialog).toBeHidden();
    await expect(overview.getByTestId("breakout-group")).toHaveCount(count);
    await expect(overview.getByText(/Not in a group yet \(0\)/)).toBeVisible();
  });

  test("a new group can start with one theme's gaps", async ({ page }) => {
    await page.goto("/breakouts");
    const overview = page.getByTestId("breakouts-overview");
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await overview.getByRole("button", { name: /new breakout group/i }).click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Give the group a name.");
    await dialog.getByLabel(/^Name/).fill("Workshop table 1");
    await dialog.getByLabel(/^Theme/).selectOption("priority");
    await dialog.getByLabel(/^Value/).selectOption({ index: 1 });
    await expect(dialog.getByText(/Starts with \d+ gap/)).toBeVisible();
    await dialog.getByRole("button", { name: "Create group" }).click();
    await expect(dialog).toBeHidden();
    const card = overview.getByTestId("breakout-group").filter({ hasText: "Workshop table 1" });
    await expect(card).toContainText(/[1-9]\d* gaps?/);
  });

  test("on a group: filter and add gaps, move one to another group, remove one", async ({ page }) => {
    await page.goto("/breakouts");
    // A domain group holds only part of the plan, so the picker has gaps left to offer.
    const card = page.getByTestId("breakout-group").filter({ hasNotText: "Workshop table 1" }).last();
    const name = (await card.getByRole("heading").innerText()).trim();
    await card.getByRole("link", { name: "Open group" }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const countHeading = page.getByRole("heading", { name: /^Gaps in this group \(\d+\)$/ });
    const countOf = async () => Number((await countHeading.innerText()).match(/\((\d+)\)/)![1]);
    const before = await countOf();

    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await page.getByRole("button", { name: /^add gaps$/i }).click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await dialog.getByRole("searchbox", { name: "Search gaps" }).fill("zzz-nothing");
    await expect(dialog.getByText("No gaps match.")).toBeVisible();
    await dialog.getByRole("searchbox", { name: "Search gaps" }).fill("");
    await dialog.getByLabel(/^Select all shown/).check();
    const selected = Number((await dialog.getByText(/\d+ selected/).innerText()).match(/\d+/)![0]);
    expect(selected).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: new RegExp(`^Add ${selected} gap`) }).click();
    await expect(dialog).toBeHidden();
    await expect(countHeading).toHaveText(`Gaps in this group (${before + selected})`);

    const first = page.getByRole("article").first();
    const gapId = (await first.locator("h3 span").first().innerText()).trim();
    await first.getByLabel("Move to another group").selectOption({ index: 1 });
    await expect(page.getByRole("article").filter({ hasText: gapId })).toHaveCount(0);

    const next = page.getByRole("article").first();
    const nextId = (await next.locator("h3 span").first().innerText()).trim();
    await next.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("article").filter({ hasText: nextId })).toHaveCount(0);
  });
});
