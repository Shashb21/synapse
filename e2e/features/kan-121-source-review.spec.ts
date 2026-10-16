/** Manual cited findings stay proposals until an explicit human decision, including with AI off. */
import { expect, test } from "@playwright/test";
import { iegpAction, resetWorkspace, runStage } from "../support/synapse";
import { freshWorkspace } from "../support/session";

freshWorkspace({ name: "Cited source review" });

test("KAN-145 keyboard review retains pending, dismissed and accepted outcomes with safe stale errors", async ({ page, request }) => {
  await resetWorkspace(request);
  const gap = await iegpAction(request, { action: "create_gap", name: "Cited review decision", domain: "comparative_effectiveness", statement: "Comparative outcomes in adults", rationale: "Cited review browser fixture" });
  const tactic = await iegpAction(request, { action: "record_missed_tactic", name: "Cited review protocol", type: "rwe_study", evidence_question: "Comparative outcomes", population: "Adults", status: "ongoing", rationale: "Cited review browser fixture" });
  await iegpAction(request, { action: "assign_tactic", gap_id: gap.id, tactic_id: tactic.id, overall: "partial", rationale: "Original human judgement remains on record" });
  const sourceResponse = await request.post("/api/sources/blocks", { data: { action: "manual_source", title: "Retained paediatric protocol", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", blocks: [{ text: "The study includes children only. Operational appendix." }], rationale: "Retained cited browser fixture" } });
  expect(sourceResponse.ok()).toBe(true);
  const source = await sourceResponse.json();
  const record = await (await request.get(`/api/gaps/${gap.id}`)).json();
  const coverageId = record.coverages[0].id;
  const ai = await request.post("/api/control", { data: { action: "set_ai_enabled", enabled: false } });
  expect(ai.ok()).toBe(true);
  try {
    await page.goto(`/sources/${source.source_id}`);
    const review = page.getByRole("region", { name: "Cited source review" });
    await review.getByRole("button", { name: "Raise source discrepancy", exact: true }).focus();
    await page.keyboard.press("Enter");
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Retained source block").selectOption(source.block_ids[0]);
    await dialog.getByLabel("Exact supporting passage", { exact: false }).fill("Invented passage");
    await dialog.getByLabel("Affected relationship").selectOption(coverageId);
    await dialog.getByLabel("Rationale (required)", { exact: false }).fill("The protocol challenges the recorded population");
    await dialog.getByRole("button", { name: "Raise discrepancy", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("actual passage");
    await expect(dialog.getByLabel("Exact supporting passage", { exact: false })).toHaveValue("Invented passage");
    await dialog.getByLabel("Exact supporting passage", { exact: false }).fill("The study includes children only.");
    await dialog.getByRole("button", { name: "Raise discrepancy", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(review.getByText("Pending source discrepancy — current confirmation challenged", { exact: true })).toBeVisible();
    const pending = await (await request.get(`/api/gaps/${gap.id}`)).json();
    expect(pending.coverages[0].overall).toBe("partial");
    expect(pending.coverages[0].fit.review_reasons.join(" ")).toMatch(/pending source discrepancy/i);
    await page.screenshot({ path: "/private/tmp/kan145-pending-desktop.png", fullPage: true });
    await page.goto(`/gaps/${gap.id}`);
    await expect(page.getByRole("region", { name: "Cited source review" }).getByText("The protocol challenges the recorded population", { exact: true })).toBeVisible();
    await page.goto(`/tactics/${tactic.id}`);
    await expect(page.getByRole("region", { name: "Cited source review" }).getByText("The protocol challenges the recorded population", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dismiss discrepancy", exact: true }).focus();
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Rationale (required)", { exact: false }).fill("This appendix does not change the current judgement");
    await dialog.getByRole("button", { name: "Dismiss discrepancy", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Source discrepancy dismissed", { exact: true })).toBeVisible();
    const dismissed = await (await request.get(`/api/gaps/${gap.id}`)).json();
    expect(dismissed.coverages[0].overall).toBe("partial");
    expect(dismissed.coverages[0].fit.review_reasons.join(" ")).not.toMatch(/pending source discrepancy/i);
    await iegpAction(request, { action: "create_source_discrepancy", source_id: source.source_id, block_id: source.block_ids[0], passage: "The study includes children only.", gap_id: gap.id, tactic_id: tactic.id, coverage_id: coverageId, rationale: "Population requires a reviewed protocol correction" });
    await page.reload();
    await page.getByRole("button", { name: "Review tactic correction", exact: true }).focus();
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Field to correct").selectOption("population");
    await dialog.getByLabel("Reviewed correction", { exact: true }).fill("Children");
    await dialog.getByLabel("I reviewed the underlying change against the cited source").selectOption("true");
    await dialog.getByLabel("Rationale (required)", { exact: false }).fill("Reviewed the actual protocol before changing population");
    await iegpAction(request, { action: "modify_tactic", tactic_id: tactic.id, geography: "Europe", rationale: "Another reviewer updated this record after the form opened" });
    await dialog.getByRole("button", { name: "Accept reviewed correction", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("Correction target changed");
    await expect(dialog.getByLabel("Reviewed correction", { exact: true })).toHaveValue("Children");
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("button", { name: "Review tactic correction", exact: true }).focus();
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Field to correct").selectOption("population");
    await dialog.getByLabel("Reviewed correction", { exact: true }).fill("Children");
    await dialog.getByLabel("I reviewed the underlying change against the cited source").selectOption("true");
    await dialog.getByLabel("Rationale (required)", { exact: false }).fill("Reviewed the current record and cited protocol together");
    await dialog.getByRole("button", { name: "Accept reviewed correction", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Source discrepancy accepted — correction recorded", { exact: true })).toBeVisible();
    await page.getByTestId("source-review").filter({ hasText: "Source discrepancy accepted" }).locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("tactic population: Adults → Children", { exact: true })).toBeVisible();
    const accepted = await (await request.get(`/api/gaps/${gap.id}`)).json();
    expect(accepted.coverages[0]).toMatchObject({ overall: "partial", stale: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/private/tmp/kan145-accepted-mobile.png", fullPage: true });
  } finally {
    await request.post("/api/control", { data: { action: "set_ai_enabled", enabled: true } });
  }
});


test("KAN-146 failed comparison keeps parsed content, keyboard retry and manual review available", async ({ page, request }) => {
  await resetWorkspace(request);
  await runStage(request, "S0", { files: [{ title: "Incoming comparison recovery", filename: "comparison-recovery.txt", source_type: "stakeholder_interview", stakeholder_function: "medical_affairs", text: "The protocol includes children only. Retained content for manual review." }] });
  const parsed = await runStage<{ documents: { source_id: string }[] }>(request, "S1");
  const sourceId = parsed.output.documents[0].source_id;
  await page.goto(`/sources/${sourceId}`);
  const comparison = page.getByRole("region", { name: "Automatic source comparison" });
  await expect(comparison.getByRole("status")).toContainText("Comparison failed");
  await expect(comparison).not.toContainText("no discrepancies detected");
  await expect(page.getByText("The protocol includes children only. Retained content for manual review.", { exact: true })).toBeVisible();
  const manual = page.getByRole("region", { name: "Cited source review" });
  await expect(manual.getByRole("button", { name: "Attach supporting source", exact: true })).toBeVisible();
  await expect(manual.getByRole("button", { name: "Raise source discrepancy", exact: true })).toBeVisible();
  await comparison.getByRole("button", { name: "Retry comparison", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Run comparison", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(comparison.getByRole("status")).toContainText("Comparison failed");
  await request.post("/api/control", { data: { action: "set_ai_enabled", enabled: false } });
  try {
    await iegpAction(request, { action: "retry_source_comparison", source_id: sourceId });
    await page.reload();
    await expect(comparison.getByRole("status")).toContainText("Comparison not run because AI is disabled");
    await expect(manual.getByRole("button", { name: "Raise source discrepancy", exact: true })).toBeVisible();
    await page.goto("/sources");
    await expect(page.getByRole("region", { name: "Automatic source comparison" }).getByRole("status")).toContainText("AI is disabled");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/private/tmp/kan146-comparison-mobile.png", fullPage: true });
  } finally {
    await request.post("/api/control", { data: { action: "set_ai_enabled", enabled: true } });
  }
});
