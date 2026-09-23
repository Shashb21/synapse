import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke coverage for the accuracy-first shell. No module runs, no Llama —
 * just that /accuracy routes render with the shared nav.
 */

const SHELL_NAV = [
  { href: "/accuracy", label: "Workspaces" },
  { href: "/accuracy/control", label: "Routing" },
  { href: "/accuracy/runs", label: "Runs" },
] as const;

async function expectAccuracyShell(page: Page) {
  const nav = page.getByRole("navigation", { name: /^accuracy$/i });
  await expect(nav).toBeVisible();
  for (const item of SHELL_NAV) {
    await expect(nav.getByRole("link", { name: item.label })).toHaveAttribute("href", item.href);
  }
  await expect(page.getByRole("link", { name: /synapse · accuracy/i })).toBeVisible();
}

test.describe("accuracy shell", () => {
  test("workspaces page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy");
    await expect(page.getByRole("heading", { name: /^workspaces$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("control page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy/control");
    await expect(page.getByRole("heading", { name: /^accuracy routing$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });

  test("runs page renders shell nav", async ({ page }) => {
    await page.goto("/accuracy/runs");
    await expect(page.getByRole("heading", { name: /^runs$/i })).toBeVisible();
    await expectAccuracyShell(page);
  });
});
