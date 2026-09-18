import { expect, test } from "@playwright/test";

async function resetBlank(page: import("@playwright/test").Page) {
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

async function ingestFirstDemo(page: import("@playwright/test").Page) {
  await page.goto("/?place=upload");
  await page.getByRole("button", { name: /ingest this file/i }).first().click();
  await page.getByLabel(/^name$/i).fill("A. Rao");
  await page.getByRole("button", { name: /^ingest$/i }).click();
  await expect(page.getByText(/^ingested$/i).first()).toBeVisible();
}

function places(page: import("@playwright/test").Page) {
  return page.getByRole("navigation", { name: "Places" });
}

test.describe.configure({ mode: "serial" });

test.describe("wizard once, plan forever", () => {
  test.beforeEach(async ({ page }) => {
    await resetBlank(page);
  });

  test("first visit is a sidebar of places, not a stepper", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /upload sources/i })).toBeVisible();
    await expect(page.getByText(/first visit/i).first()).toBeVisible();
    await expect(places(page).getByRole("link", { name: /^upload/i })).toBeVisible();
    await expect(places(page).getByText(/^review$/i)).toBeVisible();
    await expect(places(page).getByRole("link", { name: /^review/i })).toHaveCount(0);
    await expect(places(page).getByRole("link", { name: /^plan/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /demo source files/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^high$/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^needs$/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^sources$/i })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Tapes" }).getByRole("link", { name: /^eval$/i })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Tapes" }).getByRole("link", { name: /^spec$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /1\. upload/i })).toHaveCount(0);
  });

  test("ingest extracts gaps and tactics to review with a single statement and assign only", async ({
    page,
  }) => {
    await ingestFirstDemo(page);
    await places(page).getByRole("link", { name: /^review/i }).click();
    await expect(page.getByRole("heading", { name: /^review$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^gaps$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^tactics$/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /residual evidence needs/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /create gap/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /create tactic/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /accept gap/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /accept tactic/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /accept residual/i }).first()).toBeVisible();
    await expect(page.getByText(/economic burden|comparative effectiveness/i).first()).toBeVisible();
    const gapCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept gap/i }) })
      .first();
    const statement = (await gapCard.getByRole("link").first().innerText()).trim();
    expect(statement.length).toBeGreaterThan(20);
    const copies = (await gapCard.innerText()).split(statement).length - 1;
    expect(copies).toBe(1);
    await expect(gapCard.getByText(/^Residual:/)).toHaveCount(0);
    await expect(gapCard.getByRole("heading", { name: /^tactics$/i })).toBeVisible();
    await expect(gapCard.getByText(/^None$/)).toBeVisible();
    await expect(gapCard.getByRole("button", { name: /create tactic/i })).toHaveCount(0);
    await expect(gapCard.getByRole("button", { name: /assign tactic/i })).toHaveCount(0);
    await expect(gapCard.getByText(/tactic library is empty/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /suggested mappings/i })).toHaveCount(0);
  });

  test("create tactic lives on the library, then assign from review", async ({ page }) => {
    await ingestFirstDemo(page);
    await places(page).getByRole("link", { name: /^review/i }).click();
    const gapCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept gap/i }) })
      .first();
    await expect(gapCard.getByRole("button", { name: /create tactic/i })).toHaveCount(0);

    await places(page).getByRole("link", { name: /^library/i }).click();
    await expect(page.getByRole("heading", { name: /tactic library/i })).toBeVisible();
    await page.getByRole("button", { name: /create tactic/i }).click();
    await page.getByPlaceholder("Tactic name").fill("Elderly SoC chart review");
    await page.getByPlaceholder("Evidence question").fill("Does the review cover elderly vs regional SoC?");
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /add to library/i }).click();
    await expect(page.getByRole("link", { name: /elderly soc chart review/i })).toBeVisible();

    await places(page).getByRole("link", { name: /^review/i }).click();
    await expect(gapCard.getByRole("button", { name: /assign tactic/i })).toBeVisible();
    await expect(gapCard.getByRole("button", { name: /create tactic/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /create tactic/i })).toBeVisible();
    await gapCard.getByRole("button", { name: /assign tactic/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^assign$/i }).click();
    await expect(gapCard.getByRole("link", { name: /elderly soc chart review/i })).toBeVisible();
    await expect(gapCard.getByText(/^None$/)).toHaveCount(0);
  });

  test("enter the plan then new ingest lands in review", async ({ page }) => {
    await ingestFirstDemo(page);
    await places(page).getByRole("link", { name: /^review/i }).click();
    await page.getByRole("button", { name: /accept gap/i }).first().click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();
    await page.getByRole("button", { name: /accept tactic/i }).first().click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();
    await places(page).getByRole("link", { name: /^plan/i }).click();
    await expect(page.getByRole("heading", { name: /^plan$/i })).toBeVisible();
    await page.getByRole("button", { name: /enter the plan/i }).click();
    await page.getByLabel(/^name$/i).fill("S. Iyer");
    await page.getByRole("button", { name: /go to the plan/i }).click();
    await expect(page.getByRole("heading", { name: /^plan$/i })).toBeVisible();
    await expect(page.getByText(/living plan/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^high$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^medium$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^low$/i })).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /^plan$/i })).toBeVisible();

    await places(page).getByRole("link", { name: /^upload/i }).click();
    await page.getByRole("button", { name: /ingest this file/i }).nth(1).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await places(page).getByRole("link", { name: /^review/i }).click();
    await expect(page.getByRole("button", { name: /accept gap/i }).first()).toBeVisible();
    await expect(page.getByText(/intracranial|sequencing after osimertinib/i).first()).toBeVisible();
  });

  test("accept mapping tags the tactic; create gap lands on mappings not prioritize", async ({
    page,
  }) => {
    await ingestFirstDemo(page);
    await places(page).getByRole("link", { name: /^review/i }).click();

    const gapCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept gap/i }) })
      .filter({ hasText: /comparative effectiveness|elderly/i })
      .first();
    const gapName = (await gapCard.getByRole("link").first().innerText()).trim();
    await gapCard.getByRole("button", { name: /accept gap/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();

    const tacticCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept tactic/i }) })
      .filter({ hasText: /chart review|≥65|aged 65/i })
      .first();
    const tacticName = (await tacticCard.getByRole("link").first().innerText()).trim();
    await tacticCard.getByRole("button", { name: /accept tactic/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();

    await places(page).getByRole("link", { name: /^mappings/i }).click();
    const suggestion = page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: /accept mapping/i }) })
      .first();
    await expect(suggestion).toBeVisible();
    await expect(suggestion.locator("p").first()).toHaveText(gapName);
    await expect(suggestion.locator("ul li").first()).toBeVisible();
    await expect(suggestion.locator("ul li").first()).toHaveText(/.{12,}/);
    await expect(suggestion.getByText(/score:\s*\d/i)).toHaveCount(0);
    await suggestion.getByRole("button", { name: /accept mapping/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept mapping$/i }).click();
    await expect(page.getByRole("button", { name: /accept mapping/i })).toHaveCount(0);

    const mapped = page.locator("article").filter({ hasText: gapName }).first();
    await expect(mapped.locator("a", { hasText: tacticName })).toBeVisible();

    await places(page).getByRole("link", { name: /^review/i }).click();
    await page.getByRole("button", { name: /create gap/i }).first().click();
    await page.getByPlaceholder(/what evidence is missing/i).fill(
      "Need ILD characterisation in community oncology clinics after month six.",
    );
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /add gap/i }).click();
    await places(page).getByRole("link", { name: /^mappings/i }).click();
    await expect(page.getByText(/community oncology/i).first()).toBeVisible();
    await places(page).getByRole("link", { name: /^plan/i }).click();
    await expect(page.getByText(/community oncology/i)).toHaveCount(0);
  });

  test("review validates residual leftovers in the same step, not a later pressure-test screen", async ({
    page,
  }) => {
    await ingestFirstDemo(page);
    await places(page).getByRole("link", { name: /^review/i }).click();
    const residualCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept residual/i }) })
      .first();
    await expect(residualCard).toBeVisible();
    await expect(residualCard.getByRole("button", { name: /reject residual/i })).toBeVisible();
    await expect(residualCard.getByRole("button", { name: /modify residual/i })).toBeVisible();
    const leftover = (await residualCard.locator("p").nth(1).innerText()).trim();
    await expect(residualCard.getByText(/^Parent:/)).toBeVisible();
    expect(leftover.length).toBeGreaterThan(12);
    await residualCard.getByRole("button", { name: /accept residual/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /add as gap/i }).click();

    await places(page).getByRole("link", { name: /^mappings/i }).click();
    await expect(page.getByRole("heading", { name: /residual evidence needs/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /suggested mappings/i })).toBeVisible();
    await expect(page.getByText(leftover, { exact: true }).first()).toBeVisible();
  });

  test("eval tape is view-only and engine cannot auto-close", async ({ page }) => {
    await page.goto("/evals");
    await expect(page.getByRole("heading", { name: /eval tape/i })).toBeVisible();
    await expect(page.getByText(/engineMaySetStatus/i)).toBeVisible();
    await expect(page.getByText(/false/i).first()).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });

  test("spec tape includes IEGP model", async ({ page }) => {
    await page.goto("/sdlc");
    await expect(page.getByRole("link", { name: /iegp model/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /problem & solution/i })).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);
  });
});
