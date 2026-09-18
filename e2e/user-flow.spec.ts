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

test.describe.configure({ mode: "serial" });

test.describe("wizard once, plan forever", () => {
  test.beforeEach(async ({ page }) => {
    await resetBlank(page);
  });

  test("first visit is a stepper, not the living plan", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /set up the velmara iegp/i })).toBeVisible();
    await expect(page.getByText(/first visit/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /1\. upload/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /2\. review/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /3\. prioritize/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /demo source files/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^high$/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^needs$/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^sources$/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^plan$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  });

  test("ingest on the wizard extracts gaps and tactics to review", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /ingest this file/i }).first().click();
    const name = page.getByLabel(/^name$/i);
    await expect(name).toHaveValue("");
    await expect(name).toHaveAttribute("placeholder", "Your name");
    await expect(page.getByText(/empty until you type/i)).toBeVisible();
    await expect(page.getByLabel(/^function$/i)).toHaveValue("evidence_lead");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await expect(page.getByText(/placeholder, not a filled value/i)).toBeVisible();
    await name.fill("A. Rao");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await expect(page.getByText(/^ingested$/i).first()).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { name: /review gaps and tactics/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /tactic library/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /suggested mappings/i })).toBeVisible();
    await expect(page.getByText(/no mapping suggestions/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create gap/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /accept gap/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /accept tactic/i }).first()).toBeVisible();
    await expect(page.getByText(/economic burden|comparative effectiveness/i).first()).toBeVisible();
    const gapCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept gap/i }) })
      .first();
    await expect(gapCard.getByRole("heading", { name: /^tactics$/i })).toBeVisible();
    await expect(gapCard.getByText(/^None$/)).toBeVisible();
    await expect(gapCard.getByRole("button", { name: /create tactic/i })).toBeVisible();
    await expect(gapCard.getByRole("button", { name: /assign tactic/i })).toHaveCount(0);
    await expect(gapCard.getByText(/tactic library is empty/i)).toBeVisible();
  });

  test("create tactic on a review gap lists it on that gap", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /ingest this file/i }).first().click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await expect(page.getByText(/^ingested$/i).first()).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const gapCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept gap/i }) })
      .first();
    await expect(gapCard.getByText(/^None$/)).toBeVisible();
    await gapCard.getByRole("button", { name: /create tactic/i }).click();
    await page.getByPlaceholder("Tactic name").fill("Elderly SoC chart review");
    await page.getByPlaceholder("Evidence question").fill("Does the review cover elderly vs regional SoC?");
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(gapCard.getByRole("link", { name: /elderly soc chart review/i })).toBeVisible();
    await expect(gapCard.getByText(/^None$/)).toHaveCount(0);
    await expect(gapCard.getByRole("button", { name: /create tactic/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /tactic library/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /elderly soc chart review/i })).toHaveCount(2);
  });

  test("enter the plan then new ingest lands in the inbox", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /ingest this file/i }).first().click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await expect(page.getByText(/^ingested$/i).first()).toBeVisible();
    await page.getByRole("button", { name: /2\. review/i }).click();
    await page.getByRole("button", { name: /accept gap/i }).first().click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();
    await page.getByRole("button", { name: /accept tactic/i }).first().click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();
    await page.getByRole("button", { name: /3\. prioritize/i }).click();
    await expect(page.getByRole("heading", { name: /^prioritize$/i })).toBeVisible();
    await page.getByRole("button", { name: /enter the plan/i }).click();
    await page.getByLabel(/^name$/i).fill("S. Iyer");
    await page.getByRole("button", { name: /go to the plan/i }).click();
    await expect(page.getByRole("heading", { name: /^velmara iegp$/i })).toBeVisible();
    await expect(page.getByText(/living plan/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^inbox/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /suggested mappings/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /tactic library/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^high$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^medium$/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^low$/i })).toBeVisible();

    await page.getByRole("heading", { name: /add sources/i }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: /ingest this file/i }).nth(1).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await page.getByRole("heading", { name: /^inbox/i }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /accept gap/i }).first()).toBeVisible();
    await expect(page.getByText(/intracranial|sequencing after osimertinib/i).first()).toBeVisible();
  });

  test("accept mapping tags the tactic on the gap; create gap lands in prioritize", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /ingest this file/i }).first().click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^ingest$/i }).click();
    await expect(page.getByText(/^ingested$/i).first()).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    const gapCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept gap/i }) })
      .first();
    const gapName = (await gapCard.getByRole("link").first().innerText()).trim();
    await gapCard.getByRole("button", { name: /accept gap/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();

    const tacticCard = page
      .locator("article")
      .filter({ has: page.getByRole("button", { name: /accept tactic/i }) })
      .first();
    const tacticName = (await tacticCard.getByRole("link").first().innerText()).trim();
    await tacticCard.getByRole("button", { name: /accept tactic/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept$/i }).click();

    const suggestion = page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: /accept mapping/i }) })
      .first();
    await expect(suggestion).toBeVisible();
    await expect(suggestion.locator("p").first()).toHaveText(gapName);
    await suggestion.getByRole("button", { name: /accept mapping/i }).click();
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /^accept mapping$/i }).click();
    await expect(page.getByRole("button", { name: /accept mapping/i })).toHaveCount(0);

    await page.getByRole("button", { name: /3\. prioritize/i }).click();
    const prioritized = page.locator("article").filter({ hasText: gapName }).first();
    await expect(prioritized.locator("a", { hasText: tacticName })).toBeVisible();

    await page.getByRole("button", { name: /2\. review/i }).click();
    await page.getByRole("button", { name: /create gap/i }).first().click();
    await page.getByPlaceholder(/what evidence is missing/i).fill(
      "Need ILD characterisation in community oncology clinics after month six.",
    );
    await page.getByLabel(/^name$/i).fill("A. Rao");
    await page.getByRole("button", { name: /add gap/i }).click();
    await page.getByRole("button", { name: /3\. prioritize/i }).click();
    await expect(page.getByText(/community oncology/i).first()).toBeVisible();
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
