import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { svgMarkupForRaster } from "../../src/accuracy/modules/gantt-project/export-svg";
import { workspaceUrl } from "../support/accuracy";

test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
});

async function seedDatedGantt(request: APIRequestContext) {
  const wsRes = await request.post("/api/accuracy/workspaces", {
    data: {
      name: "E2E Gantt save-final",
      slug: `e2e-gantt-${Date.now().toString(36)}`,
      org_name: "E2E Gantt org",
    },
  });
  const ws = (await wsRes.json()) as { ok: boolean; workspace_id: string };
  expect(ws.ok).toBe(true);
  const workspace_id = ws.workspace_id;

  const gapRes = await request.post("/api/accuracy/claims", {
    data: {
      workspace_id,
      claim_type: "gap",
      statement: "Need overall survival evidence in 2L NSCLC",
      status: "validated",
      validated: true,
    },
  });
  const gap = (await gapRes.json()) as { claim: { id: string } };

  const t1Res = await request.post("/api/accuracy/claims", {
    data: {
      workspace_id,
      claim_type: "tactic",
      statement: "Pivotal OS follow-up study",
      status: "validated",
      validated: true,
      metadata: {
        start: "2026-01-01",
        end: "2026-06-01",
        readout: "2026-07-01",
        tactic_type: "clinical_study",
      },
    },
  });
  const t1 = (await t1Res.json()) as { claim: { id: string } };

  await request.post("/api/accuracy/claims", {
    data: {
      workspace_id,
      claim_type: "tactic",
      statement: "Congress abstract after readout",
      status: "validated",
      validated: true,
      metadata: {
        start: "2026-03-01",
        end: "2026-09-01",
        tactic_type: "congress_abstract",
        depends_on: [t1.claim.id],
      },
    },
  });

  await request.post("/api/accuracy/coverage", {
    data: {
      workspace_id,
      gap_id: gap.claim.id,
      tactic_id: t1.claim.id,
      overall: "covers",
      rationale: "Pivotal follow-up addresses the OS gap",
    },
  });

  return workspace_id;
}

/** Evidence screenshots land in this test's own output folder and are attached to the report. */
async function shot(page: Page, name: string) {
  const path = test.info().outputPath(name);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test.describe("accuracy Gantt save-final truth", () => {
  test("click detail, export PNG, save-final hash and audit bundle", async ({ page, request }) => {
    const workspace_id = await seedDatedGantt(request);
    await page.goto(workspaceUrl("/admin/accuracy/timeline", workspace_id));
    await expect(page.getByRole("heading", { name: /^timeline$/i })).toBeVisible();
    await expect(page.getByText(/2 bar\(s\) from validated tactics only/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /export png/i })).toBeEnabled();
    await expect(page.getByRole("button", { name: /save as final/i })).toBeEnabled();
    await expect(page.getByTestId("gantt-snapshot-hash")).toHaveCount(0);
    await shot(page, "gantt_timeline_validated_bars_inline.png");

    const pivotal = page.getByRole("button", { name: /pivotal os follow-up study/i });
    await expect(pivotal).toBeVisible();
    await pivotal.click();
    await expect(page.getByRole("heading", { name: /pivotal os follow-up study/i })).toBeVisible();
    await expect(page.getByText(/need overall survival evidence in 2l nsclc/i)).toBeVisible();
    await expect(page.getByText(/readout/i).first()).toBeVisible();
    await expect(page.getByText(/unblocks congress abstract after readout/i)).toBeVisible();
    await shot(page, "gantt_activity_detail_inline.png");

    await page.keyboard.press("Escape");
    const congress = page.getByRole("button", { name: /congress abstract after readout/i });
    await congress.click();
    await expect(page.getByText(/depends on pivotal os follow-up study/i)).toBeVisible();
    await page.keyboard.press("Escape");

    await pivotal.focus();
    await expect(pivotal).toBeFocused();
    await pivotal.press("ArrowDown");
    await expect(congress).toBeFocused();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /export png/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
    expect(download.suggestedFilename()).toContain(workspace_id);

    await page.getByPlaceholder(/final iegp truth/i).fill(
      "Signed off after ledger review of OS follow-up.",
    );
    await page.getByRole("button", { name: /^save as final$/i }).click();
    await expect(page.getByText(/saved v1 as final/i)).toBeVisible();
    const hash = page.getByTestId("gantt-snapshot-hash");
    await expect(hash).toBeVisible();
    await expect(hash).toContainText(/[a-f0-9]{64}/);
    const timelineHash = (await hash.textContent()) ?? "";
    const hex = /[a-f0-9]{64}/.exec(timelineHash)?.[0];
    expect(hex).toBeTruthy();
    const auditLink = page.getByTestId("gantt-audit-bundle-link");
    await expect(auditLink).toBeVisible();
    await expect(auditLink).toHaveAttribute("href", /\/admin\/accuracy\/audit\?/);
    await expect(auditLink).toHaveAttribute("href", /snapshot_hash=/);
    await shot(page, "gantt_save_final_hash_after.png");

    await auditLink.click();
    await expect(page.getByRole("heading", { name: /save-final gantt snapshot/i })).toBeVisible();
    await expect(page.getByTestId("audit-snapshot-hash")).toHaveText(hex!);
    await shot(page, "gantt_audit_bundle_after.png");
  });
});


test("saved v1 survives live edits and both exports; v2 replaces the complete snapshot", async ({ page, request }) => {
  const workspace_id = await seedDatedGantt(request);
  const timeline = workspaceUrl("/admin/accuracy/timeline", workspace_id);
  await page.goto(timeline);
  await page.getByPlaceholder(/final iegp truth/i).fill("Initial sign-off before live edits");
  const saveOne = page.waitForResponse(response => response.url().includes("/gantt/save-final") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^save as final$/i }).click();
  const first = await (await saveOne).json();
  await expect(page.getByTestId("gantt-snapshot-hash")).toContainText(first.snapshot_hash);
  const tactic = first.plan.snapshot.labels.find((row: { statement: string }) => row.statement === "Pivotal OS follow-up study");
  const edited = await request.patch("/api/accuracy/claims", { data: { workspace_id, claim_id: tactic.id, rationale: "New live schedule and title after sign-off", patch: { statement: "Renamed live follow-up study", start: "2027-01-01", end: "2027-06-01", readout: "2027-07-01" } } });
  expect(edited.ok()).toBe(true);
  await page.goto(timeline);
  const frozen = page.getByRole("button", { name: /pivotal os follow-up study/i });
  await expect(frozen).toBeVisible();
  await expect(frozen).toContainText("2026-01-01");
  await frozen.click();
  await expect(page.getByTestId("gantt-activity-detail")).toContainText("2026-06-01");
  await expect(page.getByTestId("gantt-activity-detail")).not.toContainText("Renamed live");
  await expect(page.getByTestId("gantt-snapshot-hash")).toContainText(first.snapshot_hash);
  const read = await (await request.get(`/api/accuracy/gantt?workspace_id=${workspace_id}`)).json();
  expect(read.activities).toEqual(first.plan.snapshot.activities);
  expect(read.catalog).toEqual(first.plan.snapshot.labels);
  expect(read.live.catalog).toEqual(expect.arrayContaining([expect.objectContaining({ statement: "Renamed live follow-up study" })]));

  const svgPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG", exact: true }).click();
  const svgDownload = await svgPromise;
  expect(svgDownload.suggestedFilename()).toContain("-v1.svg");
  const svg = await readFile((await svgDownload.path())!, "utf8");
  expect(svg).toContain("Pivotal OS follow-up study");
  expect(svg).toContain("2026-01-01");
  expect(svg).not.toContain("Renamed live follow-up study");
  expect(svg).not.toContain("2027-01-01");

  // Observe the actual image passed to canvas, rather than trusting a .png suffix.
  await page.evaluate(() => {
    const observation = window as Window & { ganttRasterInputs?: string[] };
    observation.ganttRasterInputs = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, ...coordinates: number[]) {
      if (image instanceof HTMLImageElement) {
        void fetch(image.src).then(response => response.text()).then(markup => observation.ganttRasterInputs!.push(markup));
      }
      return Reflect.apply(original, this, [image, ...coordinates]);
    };
  });
  const pngPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PNG", exact: true }).click();
  const png = await pngPromise;
  expect(png.suggestedFilename()).toContain("-v1.png");
  expect((await readFile((await png.path())!)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await expect.poll(() => page.evaluate(() => (window as Window & { ganttRasterInputs?: string[] }).ganttRasterInputs)).toEqual([svgMarkupForRaster(svg)]);
  await shot(page, "gantt_saved_v1_after_live_edit.png");

  await page.getByRole("button", { name: "Live projection (unsaved)", exact: true }).click();
  await expect(page.getByRole("button", { name: /renamed live follow-up study/i })).toContainText("2027-01-01");
  await expect(page.getByText("Unsaved live projection", { exact: false })).toBeVisible();
  await expect(page.getByTestId("gantt-snapshot-hash")).toHaveCount(0);
  await expect(page.getByText(/latest plan v1/i)).toHaveCount(0);
  const liveSvgPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG", exact: true }).click();
  const liveSvg = await liveSvgPromise;
  expect(liveSvg.suggestedFilename()).toContain("-draft.svg");
  expect(await readFile((await liveSvg.path())!, "utf8")).toContain("Renamed live follow-up study");
  await page.getByPlaceholder(/final iegp truth/i).fill("Approve the revised live projection as v2");
  const saveTwo = page.waitForResponse(response => response.url().includes("/gantt/save-final") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^save as final$/i }).click();
  const second = await (await saveTwo).json();
  expect(second.plan.version).toBe(2);
  expect(second.snapshot_hash).not.toBe(first.snapshot_hash);
  await expect(page.getByTestId("gantt-snapshot-hash")).toContainText(second.snapshot_hash);
  await expect(page.getByText(/latest plan v2/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /renamed live follow-up study/i })).toContainText("2027-01-01");
  await page.reload();
  await expect(page.getByTestId("gantt-snapshot-hash")).toContainText(second.snapshot_hash);
  await expect(page.getByRole("button", { name: /renamed live follow-up study/i })).toContainText("2027-01-01");
  const v2SvgPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG", exact: true }).click();
  const v2Svg = await v2SvgPromise;
  expect(v2Svg.suggestedFilename()).toContain("-v2.svg");
  const v2Markup = await readFile((await v2Svg.path())!, "utf8");
  expect(v2Markup).toContain("Renamed live follow-up study");
  expect(v2Markup).toContain("2027-01-01");
  await shot(page, "gantt_saved_v2.png");
});
