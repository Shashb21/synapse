import { expect, test, type Page } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { seedMapped } from "../support/synapse";

/** The document and inventory must fit the phone without hiding review controls. */
async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const inventory = page.getByTestId("evidence-inventory");
  if (await inventory.count()) expect(await inventory.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}

test.describe("KAN-156 mobile evidence and timeline", () => {
  freshWorkspace({name: "KAN-156 mobile", seed: request => seedMapped(request)});
  test.setTimeout(90_000);

  test("dependency display control is available only when the chart is visible", async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto("/timeline");
    const list = page.getByTestId("timeline-activity-list");
    const dependencies = page.getByRole("button", {name: /Dependencies/});
    const view = page.getByRole("combobox", {name: "Timeline view"});
    await expect(list).toBeVisible();
    await expect(dependencies).toBeHidden();

    await page.setViewportSize({width: 1280, height: 900});
    await expect(dependencies).toBeVisible();
    await expect(dependencies).toHaveAttribute("aria-pressed", "true");
    await dependencies.focus();
    await dependencies.press("Space");
    await expect(dependencies).toHaveAttribute("aria-pressed", "false");

    await view.selectOption("list");
    await expect(list).toBeVisible();
    await expect(dependencies).toBeHidden();
    await page.setViewportSize({width: 390, height: 844});
    await view.selectOption("chart");
    await expect(page.locator("svg[role='img']")).toBeVisible();
    await expect(dependencies).toBeVisible();
    await expect(dependencies).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({path: ".task/fresh-code-review/mobile-chart-controls.png", fullPage: true});
    await view.selectOption("responsive");
    await expect(list).toBeVisible();
    await expect(dependencies).toBeHidden();
    await page.screenshot({path: ".task/fresh-code-review/mobile-list-controls.png", fullPage: true});
  });

  test("390px keeps inventory review, sorting and shared gap panel usable", async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto("/?place=gaps");
    const rows = page.locator("tr[data-gap-id]");
    await expect(rows.first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("combobox", {name: "Sort gaps"}).selectOption("id");
    await page.getByRole("button", {name: "Reverse gap sort direction"}).click();
    const trigger = rows.first().getByTestId("gap-row-toggle");
    await trigger.focus();
    await trigger.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const next = rows.locator("[data-next-action] button").first();
    await next.focus();
    await next.press("Enter");
    const review = page.getByRole("region", {name: "Outstanding gap review"});
    await expect(review).toBeVisible();
    await expect(review.locator("button:focus, a:focus, [tabindex='-1']:focus")).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({path: ".task/kan156-157/mobile-inventory.png", fullPage: true});
    await page.setViewportSize({width: 1440, height: 1000});
    const header = page.getByRole("button", {name: "Sort by ID", exact: true});
    await header.click();
    await expect(page.locator("thead th").first()).toHaveAttribute("aria-sort", "ascending");
  });

  test("390px activity list opens existing pending dates and dated activity editors", async ({page}, testInfo) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto("/timeline");
    const list = page.getByTestId("timeline-activity-list");
    await expect(list).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const activity = list.locator("li[data-activity-list-id]").filter({hasText: "Not dated yet"}).first();
    await expect(activity).toBeVisible();
    const activityId = await activity.getAttribute("data-activity-list-id");
    await activity.getByRole("button").focus();
    await activity.getByRole("button").press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(activity.getByRole("button")).toBeFocused();
    await activity.getByRole("button").press("Enter");
    const sheet = page.getByRole("dialog").first();
    await expect(sheet).toBeVisible({timeout: 10_000});
    const setDates = sheet.getByRole("button", {name: /^Set dates for/});
    try {
      await expect(setDates).toBeVisible({timeout: 10_000});
    } catch (error) {
      await testInfo.attach("pending-sheet-body", {body: await page.locator("body").innerText(), contentType: "text/plain"});
      await page.screenshot({path: ".task/kan156-157/mobile-pending-sheet-diagnostic.png", fullPage: true});
      throw error;
    }
    await setDates.click();
    const dates = page.getByRole("dialog", {name: /^Set dates for/});
    for (const label of ["Start", "End"]) {
      await expect(dates.getByLabel(`${label} (required)`, {exact: true})).toHaveAttribute("required", "");
      await expect(dates.getByLabel(`${label} (required)`, {exact: true})).toHaveAttribute("aria-required", "true");
    }
    await dates.getByLabel("Start (required)", {exact: true}).fill("2026-11-01");
    await dates.getByLabel("End (required)", {exact: true}).fill("2027-04-30");
    await dates.getByPlaceholder(/why this decision/i).fill("Study team confirmed these dates on mobile");
    await dates.getByRole("button", {name: /Save dates/i}).click();
    await expect(dates).toBeHidden();
    await page.keyboard.press("Escape");
    await page.reload();
    const dated = list.locator(`li[data-activity-list-id="${activityId}"]`).first();
    await expect(dated).toContainText("2026-11-01 → 2027-04-30");
    await dated.getByRole("button").click();
    await page.getByRole("dialog").getByRole("button", {name: "Edit", exact: true}).click();
    await expect(page.getByRole("dialog").getByLabel("Start", {exact: true})).toBeVisible();
    await page.screenshot({path: ".task/kan156-157/mobile-timeline-edit.png", fullPage: true});
    await page.keyboard.press("Escape");
    await expect(dated.getByRole("button")).toBeFocused();
    await page.getByRole("combobox", {name: "Timeline view"}).selectOption("chart");
    await expect(page.locator("svg[role='img']")).toBeVisible();
    const chartActivity = page.locator(`g[data-activity-id="${activityId}"]`).first();
    await chartActivity.focus();
    await chartActivity.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chartActivity).toBeFocused();
    await page.getByRole("combobox", {name: "Timeline view"}).selectOption("list");
    await expect(list).toBeVisible();
    await dated.getByRole("button").focus();
    await dated.getByRole("button").press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dated.getByRole("button")).toBeFocused();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", {name: /Export.*PNG/i}).click();
    const png = await downloaded;
    expect(png.suggestedFilename()).toMatch(/\.png$/);
    await png.saveAs(testInfo.outputPath("timeline-from-list.png"));
    const stream = await png.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
