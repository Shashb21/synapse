import { expect, test, type Page } from "@playwright/test";

async function resetBlank(page: Page) {
  const res = await page.request.post("/api/iegp", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({
      action: "reset",
      actor_name: "E2E",
      actor_function: "evidence_lead",
    }),
  });
  if (!res.ok()) {
    throw new Error(`reset failed: ${res.status()} ${await res.text()}`);
  }
}

async function ingestFirstDemo(page: Page) {
  await page.goto("/?place=upload");
  await page.getByRole("button", { name: /ingest this file/i }).first().click();
  await page.getByLabel(/^name$/i).fill("A. Rao");
  await page.getByRole("button", { name: /^ingest$/i }).click();
  await expect(page.getByText(/^ingested$/i).first()).toBeVisible();
}

function places(page: Page) {
  return page.getByRole("navigation", { name: "Places" });
}

test.describe.configure({ mode: "serial" });

test.describe("gaps then prioritize then tactics", () => {
  test.beforeEach(async ({ page }) => {
    await resetBlank(page);
  });

  test("first visit is upload; later places stay locked", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /upload sources/i })).toBeVisible();
    await expect(places(page).getByRole("link", { name: /^upload/i })).toBeVisible();
    await expect(places(page).getByRole("link", { name: /^gaps/i })).toHaveCount(0);
    await expect(places(page).getByRole("link", { name: /^prioritize/i })).toHaveCount(0);
    await expect(places(page).getByRole("link", { name: /^tactics/i })).toHaveCount(0);
    await expect(places(page).getByText(/^review$/i)).toHaveCount(0);
    await expect(places(page).getByText(/^mappings$/i)).toHaveCount(0);
  });

  test("ingest presents mapped gaps with computed status, not accept/reject", async ({ page }) => {
    await ingestFirstDemo(page);
    await places(page).getByRole("link", { name: /^gaps/i }).click();
    await expect(page.getByRole("heading", { name: /^gaps$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /add open gap/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /accept gap/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /accept tactic/i })).toHaveCount(0);
    const statusGuide = page.getByRole("region", { name: /gap status/i });
    await expect(statusGuide.getByText("Open", { exact: true })).toBeVisible();
    await expect(statusGuide.getByText("Partially Addressed", { exact: true })).toBeVisible();
    await expect(statusGuide.getByText("Addressed", { exact: true })).toBeVisible();
    await expect(page.getByText(/economic burden|comparative effectiveness/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /validate status|split or rewrite/i }).first()).toBeVisible();
  });
});
