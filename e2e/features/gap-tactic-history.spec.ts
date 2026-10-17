import { expect, test } from "@playwright/test";
import { freshWorkspace } from "../support/session";
import { iegpAction } from "../support/synapse";

let gaps: string[] = [];
let tacticId = "";
freshWorkspace({ name: "KAN135 relationship history", seed: async request => {
  gaps = [];
  for (const name of ["Comparative survival", "Long term outcomes"]) {
    const gap = await iegpAction(request, { action: "create_gap", name, statement: `${name} evidence is missing`, domain: "comparative_effectiveness" });
    gaps.push(String(gap.id));
    await iegpAction(request, { action: "validate_gap", gap_id: gap.id });
  }
  const tactic = await iegpAction(request, { action: "record_missed_tactic", name: "Shared registry cohort", type: "rwe_study", status: "planned", evidence_question: "What outcomes occur in the registry?" });
  tacticId = String(tactic.id);
} });

test("reason-required links share history across both records, preserve reused coverage and survive unlink", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  for (const [index, coverage] of ["partial", "limited"].entries()) {
    await page.goto(`/gaps/${gaps[index]}`);
    await page.getByRole("button", { name: "Map tactic with coverage", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Map tactic with coverage", exact: true });
    await dialog.getByRole("button", { name: "Assess and link", exact: true }).click();
    await dialog.getByLabel("Overall coverage").selectOption(coverage);
    await dialog.getByRole("button", { name: "Assess and link", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Enter a rationale of at least three characters.");
    await dialog.getByLabel("Rationale (required)").fill(`Registry supports gap ${index + 1} at ${coverage} coverage`);
    await dialog.getByRole("button", { name: "Assess and link", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("entity-history")).toContainText(`Registry supports gap ${index + 1} at ${coverage} coverage`);
  }
  const record = await (await request.get(`/api/tactics/${tacticId}`)).json();
  expect(record.coverages.map((row: { overall: string }) => row.overall).sort()).toEqual(["limited", "partial"]);
  await page.getByRole("link", { name: "Shared registry cohort", exact: true }).first().click();
  const panel = page.getByRole("dialog", { name: "Tactic details", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
  await expect(panel.getByTestId("entity-history")).toContainText("Registry supports gap 1 at partial coverage");
  await expect(panel.getByTestId("entity-history")).toContainText("Registry supports gap 2 at limited coverage");
  await panel.screenshot({ path: testInfo.outputPath("shared-relationship-history.png") });
  await page.keyboard.press("Escape");
  await page.goto(`/gaps/${gaps[0]}`);
  await page.getByRole("button", { name: "Remove mapping", exact: true }).click();
  const unlink = page.getByRole("dialog", { name: "Remove mapping", exact: true });
  await unlink.getByRole("button", { name: "Remove mapping", exact: true }).click();
  await expect(unlink.getByRole("alert")).toContainText("Rationale");
  await unlink.getByLabel("Rationale (required)").fill("Remove survival mapping after review of the registry population");
  await unlink.getByRole("button", { name: "Remove mapping", exact: true }).click();
  await expect(unlink).not.toBeVisible();
  const gapHistory = (await (await request.get(`/api/gaps/${gaps[0]}`)).json()).history;
  const tacticHistory = (await (await request.get(`/api/tactics/${tacticId}`)).json()).history;
  const event = gapHistory.find((row: { rationale: string }) => row.rationale === "Registry supports gap 1 at partial coverage");
  expect(tacticHistory.find((row: { id: string }) => row.id === event.id)).toBeTruthy();
  await page.goto(`/tactics/${tacticId}`);
  await page.getByRole("group", { name: "History", exact: true }).locator("summary").first().click();
  await expect(page.getByTestId("entity-history")).toContainText("Registry supports gap 1 at partial coverage");
  await expect(page.getByTestId("entity-history")).toContainText("Remove survival mapping after review of the registry population");
  await expect(page.getByRole("link", { name: /Long term outcomes/ }).first()).toBeVisible();
});

test("coverage failure and stale rejection preserve the entered judgement and reason", async ({ page, request }) => {
  const initial = await (await request.get(`/api/tactics/${tacticId}`)).json();
  if (!initial.coverages.some((row: { gap_id: string }) => row.gap_id === gaps[1])) await iegpAction(request, { action: "assign_tactic", gap_id: gaps[1], tactic_id: tacticId, expected_relationship: JSON.stringify({ coverages: [], decision: null }), overall: "partial", rationale: "Initial coverage for recovery check" });
  await page.goto(`/gaps/${gaps[1]}`);
  await page.getByRole("button", { name: "Change overall coverage", exact: true }).click();
  const editor = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Change overall coverage", exact: true }) });
  await editor.getByRole("combobox", { name: "Overall", exact: true }).selectOption("full");
  await editor.getByLabel("Your rationale (required)").fill("Retain this registry review reason on failure");
  await page.route("**/api/iegp", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Temporary relationship failure. Try again." }) }), { times: 1 });
  await editor.getByRole("button", { name: "Change overall coverage", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("Temporary relationship failure");
  await expect(editor.getByLabel("Your rationale (required)")).toHaveValue("Retain this registry review reason on failure");
  const record = await (await request.get(`/api/tactics/${tacticId}`)).json();
  const coverage = record.coverages.find((row: { gap_id: string }) => row.gap_id === gaps[1]);
  await iegpAction(request, { action: "lock_overall", coverage_id: coverage.id, expected_relationship: coverage.relationship_version, overall: "not_relevant", rationale: "Concurrent reviewer corrected the coverage" });
  await editor.getByRole("button", { name: "Change overall coverage", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("Relationship changed");
  await expect(editor.getByRole("combobox", { name: "Overall", exact: true })).toHaveValue("full");
  await expect(editor.getByLabel("Your rationale (required)")).toHaveValue("Retain this registry review reason on failure");
  expect((await (await request.get(`/api/tactics/${tacticId}`)).json()).coverages[0].overall).toBe("not_relevant");
});

for (const mode of ["split", "rewrite"] as const) {
  test(`${mode} retains fields and reason after a stale relationship rejection, then saves a fresh review`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const created = await iegpAction(request, { action: "create_gap", name: `Partial ${mode} review`, statement: "Comparative outcomes are only partly answered", domain: "comparative_effectiveness" });
    const gapId = String(created.id);
    await iegpAction(request, { action: "validate_gap", gap_id: gapId });
    const ids: string[] = [];
    for (const name of ["Selected registry", "Remaining registry"]) {
      const tactic = await iegpAction(request, { action: "record_missed_tactic", name: `${mode} ${name}`, type: "rwe_study", status: "planned", evidence_question: "Which comparative outcomes does the registry answer?" });
      ids.push(String(tactic.id));
      await iegpAction(request, { action: "assign_tactic", gap_id: gapId, tactic_id: tactic.id, expected_relationship: JSON.stringify({ coverages: [], decision: null }), overall: "partial", rationale: "Registry answers the observed outcome slice" });
    }
    await page.goto(`/gaps/${gapId}`);
    const openDialog = () => page.getByRole("button", { name: "Resolve this Partially Addressed gap by splitting or rewriting", exact: true }).click();
    await openDialog();
    const dialog = page.getByRole("dialog", { name: "Resolve Partially Addressed gap", exact: true });
    const reason = "Keep my reviewed resolution and evidence reason";
    const fillDraft = async () => {
      if (mode === "rewrite") {
        await dialog.getByRole("button", { name: "Rewrite original", exact: true }).click();
        await dialog.getByRole("textbox", { name: "Rewritten title", exact: true }).fill("Reviewed covered replacement");
        await dialog.getByRole("combobox", { name: "Status", exact: true }).selectOption("validated_addressed");
      } else {
        await dialog.getByRole("textbox", { name: "Title", exact: true }).nth(0).fill("Reviewed covered outcome");
        await dialog.getByRole("textbox", { name: "Title", exact: true }).nth(1).fill("Reviewed remaining comparison");
      }
      await dialog.getByRole("textbox", { name: /^Rationale \(required\)/ }).fill(reason);
    };
    await fillDraft();
    const record = await (await request.get(`/api/tactics/${ids[0]}`)).json();
    await iegpAction(request, { action: "unassign_tactic", gap_id: gapId, tactic_id: ids[0], expected_relationship: record.coverages.find((row: { gap_id: string }) => row.gap_id === gapId).relationship_version, rationale: "Another reviewer explicitly removed this registry" });
    const before = await (await request.get(`/api/gaps/${gapId}`)).json();
    const submit = () => dialog.getByRole("button", { name: mode === "rewrite" ? "Rewrite and retire original" : "Split gap", exact: true }).click();
    await submit();
    await expect(dialog.getByRole("alert")).toContainText("scope changed");
    await expect(dialog.getByRole("textbox", { name: /^Rationale \(required\)/ })).toHaveValue(reason);
    await expect(dialog.getByRole("textbox", { name: mode === "rewrite" ? "Rewritten title" : "Title", exact: true }).first()).toHaveValue(mode === "rewrite" ? "Reviewed covered replacement" : "Reviewed covered outcome");
    const after = await (await request.get(`/api/gaps/${gapId}`)).json();
    expect(after.gap.retired).toBe(before.gap.retired);
    expect(after.history).toEqual(before.history);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await openDialog();
    await fillDraft();
    await submit();
    await expect(dialog).toBeHidden();
    expect((await (await request.get(`/api/gaps/${gapId}`)).json()).gap.retired).toBe(true);
  });
}
