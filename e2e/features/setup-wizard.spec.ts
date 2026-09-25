import { expect, test, type Page } from "@playwright/test";
import { ACTOR } from "../support/synapse";

/**
 * The IEGP setup wizard, end to end: a new workspace lands on /setup?new=1,
 * the wizard captures the plan's context step by step, the context is saved
 * to the workspace and shown again on revisit, and finishing starts the
 * walkthrough of the main places.
 *
 * Assumes a signed-in session with a workspace selected (the Playwright global
 * setup signs in and selects the Default workspace). The spec resets that
 * workspace to the blank plan first and again afterwards.
 */

const ASSET = `E2E Nova ${Date.now().toString(36)}`;

async function reset(page: Page) {
  const res = await page.request.post("/api/iegp", { data: { ...ACTOR, action: "reset" } });
  expect(res.ok()).toBeTruthy();
}

async function continueTo(page: Page, testId: string) {
  await page.getByRole("button", { name: /^continue$/i }).click();
  await expect(page.getByTestId(testId)).toBeVisible();
}

test.describe.serial("IEGP setup wizard", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await reset(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    // Leave no tour open over the other specs, and the workspace blank again.
    await page.request.post("/api/walkthrough", { data: { action: "dismiss", step: 0 } });
    await reset(page);
    await page.close();
  });

  test("captures the plan's context through every step", async ({ page }) => {
    await page.goto("/setup?new=1");
    await expect(page.getByTestId("setup-step-welcome")).toBeVisible();
    await page.getByRole("button", { name: /^get started$/i }).click();

    // Asset — required fields are enforced before moving on.
    await expect(page.getByTestId("setup-step-asset")).toBeVisible();
    await page.getByRole("button", { name: /^continue$/i }).click();
    await expect(page.getByText("Name the asset.")).toBeVisible();

    await page.getByLabel(/Asset \/ brand name/).fill(ASSET);
    await page.getByLabel(/INN \/ generic name/).fill("novamab");
    await page.getByLabel(/Mechanism of action/).fill("IL-23 inhibitor");
    await page.getByLabel(/Therapeutic area/).fill("Immunology");
    await page.getByRole("button", { name: /add indication/i }).click();
    await page.getByLabel("Indication 1", { exact: true }).fill("Moderate-to-severe psoriasis");
    await page.getByRole("radio", { name: "Growth" }).click();
    const markets = page.getByLabel(/Markets in scope/);
    await markets.fill("US");
    await markets.press("Enter");
    await markets.fill("Japan");
    await markets.press("Enter");
    await continueTo(page, "setup-step-company");

    // Company & plan
    await page.getByLabel(/Company situation/).fill("Phase III readout pending.");
    await page.getByLabel(/Plan owner/).fill("J. Park");
    await page.getByLabel(/Sponsoring function/).fill("Medical Affairs");
    await page.getByLabel(/Plan horizon/).fill("4");
    await page.getByLabel(/Planning cycle start/).fill("2027-01-01");
    await page.getByLabel(/Planning cycle end/).fill("2027-12-31");
    await continueTo(page, "setup-step-objectives");

    // Objectives & key decisions
    await page.getByRole("button", { name: /add objective/i }).click();
    await page.getByLabel(/^Objective 1/).fill("Win HTA in EU5");
    await page.getByRole("radio", { name: "5", exact: true }).click();
    await page.getByLabel(/Key decision/).fill("EU5 HTA filing");
    await page.getByLabel(/Decision date/).fill("2028-03-01");
    await continueTo(page, "setup-step-landscape");

    // Evidence landscape
    await page.getByRole("radio", { name: "High" }).first().click();
    await page.getByRole("button", { name: /add competitor/i }).click();
    await page.getByLabel(/^Competitor 1/).fill("JAK class");
    await page.getByLabel(/Standard of care/).fill("Biologics after topical failure");
    const payers = page.getByLabel(/Key payer \/ HTA bodies/);
    await payers.fill("NICE");
    await payers.press("Enter");
    await page.getByRole("button", { name: /add milestone/i }).click();
    await page.getByLabel(/^Milestone 1/).fill("FDA filing");
    await page.getByLabel(/^Date$/).fill("2027-06-01");
    await page.getByLabel(/Launch timeline/).fill("US 2028-H1");
    await continueTo(page, "setup-step-stakeholders");

    // Stakeholders
    await page.getByRole("button", { name: "+ HEOR" }).click();
    await page.getByLabel(/^Lead$/).fill("L. Chen");
    await continueTo(page, "setup-step-settings");

    // Treatment settings (they become setting tags and Prioritize scopes)
    const settings = page.getByLabel(/^Settings/);
    await settings.fill("1L");
    await settings.press("Enter");
    await settings.fill("Perioperative");
    await settings.press("Enter");
    await page.getByRole("button", { name: /^continue$/i }).click();

    // Connect models / Work by hand, then review.
    await page.getByRole("button", { name: /^continue$/i }).click();
    const review = page.getByTestId("setup-step-review");
    await expect(review).toBeVisible();
    for (const text of [ASSET, "Immunology", "US, Japan", "J. Park", "EU5 HTA filing", "NICE", "HEOR (L. Chen)", "1L, Perioperative"]) {
      await expect(review).toContainText(text);
    }

    await page.getByRole("button", { name: /finish & start walkthrough/i }).click();
    await expect(page).toHaveURL(/place=gaps/);
    const tour = page.getByTestId("walkthrough");
    await expect(tour).toBeVisible();
    await expect(tour).toContainText("1 of 7");
    await expect(tour).toContainText("Gaps");
  });

  test("the walkthrough moves through the places and can be closed", async ({ page }) => {
    await page.goto("/?place=gaps");
    const tour = page.getByTestId("walkthrough");
    await expect(tour).toBeVisible();
    await tour.getByRole("button", { name: /next: tactics/i }).click();
    await expect(page).toHaveURL(/place=tactics/);
    await expect(tour).toContainText("2 of 7");

    // Progress is remembered on the server.
    await page.reload();
    await expect(page.getByTestId("walkthrough")).toContainText("2 of 7");

    await page.getByRole("button", { name: /close walkthrough/i }).click();
    await expect(page.getByTestId("walkthrough")).toHaveCount(0);
    await expect
      .poll(async () => ((await (await page.request.get("/api/walkthrough")).json()) as { progress: { status: string } }).progress.status)
      .toBe("dismissed");
    await page.reload();
    await expect(page.getByTestId("walkthrough")).toHaveCount(0);
  });

  test("revisiting setup shows the saved context and restarts the walkthrough", async ({ page }) => {
    await page.goto("/setup");
    const review = page.getByTestId("setup-step-review");
    await expect(review).toContainText("This plan is set up");
    await expect(review).toContainText(ASSET);
    await expect(review).toContainText("Win HTA in EU5");

    // Edit a section and save; the change sticks.
    await page.getByTestId("setup-summary-company").getByRole("button", { name: "Edit" }).click();
    await page.getByLabel(/Plan owner/).fill("M. Hale");
    await page.getByRole("button", { name: /save & continue later/i }).click();
    await expect(page.getByTestId("setup-saved-at")).toContainText("Saved");
    await page.reload();
    await expect(page.getByTestId("setup-step-review")).toContainText("M. Hale");

    await page.getByTestId("restart-walkthrough").filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/place=gaps/);
    await expect(page.getByTestId("walkthrough")).toContainText("1 of 7");
  });
});
