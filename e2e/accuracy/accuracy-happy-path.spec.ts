import { expect, test, type Page } from "@playwright/test";
import {
  seedAccuracyFromGold,
  workspaceUrl,
  type SeedFromGoldResult,
} from "../support/accuracy";

/**
 * Coherent accuracy happy path beyond shell smoke:
 * seed (gold + local PPTX) → Sources → Ledger → Coverage → Plan.
 * No LlamaParse / live LLM — Playwright sets SYNAPSE_TEST_STUB_LLM=1.
 */

test.describe.configure({ mode: "serial" });

test.describe("accuracy happy path (seeded gold, stub LLM)", () => {
  let seed: SeedFromGoldResult;

  test.beforeAll(async ({ request }) => {
    seed = await seedAccuracyFromGold(request, {
      workspace_name: "E2E Happy Path BGB",
      parse_source: true,
    });
    expect(seed.gaps).toBe(43);
    expect(seed.tactics).toBe(36);
  });

  async function expectShell(page: Page) {
    const nav = page.getByRole("navigation", { name: /^accuracy$/i });
    await expect(nav).toBeVisible();
    await expect(page.getByRole("link", { name: /synapse · accuracy/i })).toBeVisible();
  }

  test("sources show seeded pack and parse blocks", async ({ page }) => {
    await page.goto(workspaceUrl("/accuracy/sources", seed.workspace_id));
    await expect(page.getByRole("heading", { name: /^sources$/i })).toBeVisible();
    await expectShell(page);
    await expect(page.getByText(/Workspace ·/i)).toBeVisible();
    await expect(page.getByText(/E2E Happy Path BGB/)).toBeVisible();
    await expect(page.getByText(/parse block\(s\)/i).first()).toBeVisible();
    await expect(page.getByText(/pack beone-bgb-58067-prmt5i/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /open ledger/i })).toHaveAttribute(
      "href",
      `/accuracy/ledger?workspace_id=${encodeURIComponent(seed.workspace_id)}`,
    );
  });

  test("ledger lists gaps and tactics; validate one gap", async ({ page }) => {
    await page.goto(workspaceUrl("/accuracy/ledger", seed.workspace_id));
    await expect(page.getByRole("heading", { name: /^ledger$/i })).toBeVisible();
    await expectShell(page);
    await expect(page.getByRole("heading", { name: /^gaps$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^tactics$/i })).toBeVisible();

    const gapsSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: /^gaps$/i }),
    });
    const firstGap = gapsSection.locator("li").first();
    await expect(firstGap).toBeVisible();
    await expect(firstGap.getByText(/^Draft$/i)).toBeVisible();

    await firstGap.getByPlaceholder(/why validate or reject/i).fill(
      "E2E happy path: validate first gold gap",
    );
    await firstGap.getByRole("button", { name: /^validate$/i }).click();
    await expect(firstGap.getByText(/^Validated$/i)).toBeVisible({ timeout: 30_000 });
    await expect(firstGap.getByText(/Last rationale:/i)).toContainText("E2E happy path");
  });

  test("coverage queue: stub LLM assist then decide one pair", async ({ page }) => {
    await page.goto(workspaceUrl("/accuracy/coverage", seed.workspace_id));
    await expect(page.getByRole("heading", { name: /^coverage$/i })).toBeVisible();
    await expectShell(page);
    await expect(page.getByText(/undecided/i).first()).toBeVisible();
    await expect(page.getByText(/Pair 1 of/i)).toBeVisible();

    const card = page.locator("article").filter({ hasText: /^Gap$/i }).first();
    await expect(card.getByText(/^Gap$/i)).toBeVisible();
    await expect(card.getByText(/^Tactic$/i)).toBeVisible();
    await expect(card.getByText(/Status: undecided/i)).toBeVisible();

    await page.getByRole("button", { name: /suggest with llm/i }).click();
    await expect(page.getByText(/Assist \(stub\)/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/not_relevant → none/i)).toBeVisible();

    // Assist pre-fills rationale; confirm with a decide button.
    await card.getByRole("button", { name: /^none$/i }).click();
    await expect(page.getByText(/decided pair/i)).toBeVisible({ timeout: 30_000 });
  });

  test("plan lists seeded gaps and accepts a priority band", async ({ page }) => {
    await page.goto(workspaceUrl("/accuracy/plan", seed.workspace_id));
    await expect(page.getByRole("heading", { name: /^plan$/i })).toBeVisible();
    await expectShell(page);
    await expect(page.getByText(/43 gap\(s\)/i)).toBeVisible();

    const firstCard = page.locator("article").first();
    await expect(firstCard).toBeVisible();
    await firstCard.getByRole("button", { name: /^high$/i }).click();
    await expect(firstCard.getByRole("button", { name: /^high$/i })).toHaveClass(
      /bg-foreground/,
      { timeout: 20_000 },
    );
  });
});
