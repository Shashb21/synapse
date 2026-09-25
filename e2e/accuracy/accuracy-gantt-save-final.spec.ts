import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { workspaceUrl } from "../support/accuracy";

test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
});

const ARTIFACTS = "/opt/cursor/artifacts";

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

async function shot(page: Page, name: string) {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: `${ARTIFACTS}/${name}`, fullPage: true });
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
