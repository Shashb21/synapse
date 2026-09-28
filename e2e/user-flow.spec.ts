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

  test("first visit is upload; later places open but say what they wait on", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /upload sources/i })).toBeVisible();
    await expect(places(page).getByRole("link", { name: /^upload/i })).toBeVisible();
    for (const name of [/^gaps/i, /^prioritize/i, /^tactics/i]) {
      await expect(places(page).getByRole("link", { name })).toBeVisible();
      await expect(places(page).getByRole("link", { name })).toContainText(/waiting on an earlier step/i);
    }
    await expect(places(page).getByRole("link", { name: /^upload/i })).not.toContainText(/waiting/i);

    await places(page).getByRole("link", { name: /^gaps/i }).click();
    await expect(page.getByRole("heading", { name: /^gaps$/i })).toBeVisible();
    await expect(page.getByTestId("step-waiting")).toContainText(/waiting on upload/i);
    await expect(page.getByRole("button", { name: /add open gap/i })).toBeVisible();

    await places(page).getByRole("link", { name: /^prioritize/i }).click();
    await expect(page.getByRole("heading", { name: /^prioritize$/i })).toBeVisible();
    await expect(page.getByTestId("step-waiting")).toContainText(/waiting on gaps/i);
    await page.getByTestId("step-waiting").getByRole("link", { name: /go to gaps/i }).click();
    await expect(page).toHaveURL(/place=gaps/);
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
    await expect(
      page.getByText(/Every extracted gap is shown with its mapped tactics and computed status/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^all \(/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^partial \(/i })).toBeVisible();
    await expect(page.getByText(/economic burden|comparative effectiveness/i).first()).toBeVisible();
    await expect(
      page
        .getByRole("button", { name: /confirm status|resolve this partially addressed gap/i })
        .first(),
    ).toBeVisible();
  });

  test("tactics place URLs open and say they wait on Prioritize", async ({ page }) => {
    const query = await page.goto("/?place=tactics");
    expect(query?.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: /^tactics$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /waiting on prioritize/i })).toBeVisible();
    await expect(page.getByRole("region", { name: /tag the same tactic/i })).toBeVisible();

    const dedicated = await page.goto("/tactics");
    expect(dedicated?.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: /^tactics$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /waiting on prioritize/i })).toBeVisible();
  });
});
