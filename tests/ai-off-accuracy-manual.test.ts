import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

import type { ReactElement } from "react";
import { registerAccuracyStack } from "@/accuracy";
import { PATCH as claimsPatch, POST as claimsPost } from "@/app/api/accuracy/claims/route";
import { POST as validatePost } from "@/app/api/accuracy/claims/validate/route";
import { POST as priorityPost } from "@/app/api/accuracy/claims/priority/route";
import { POST as coveragePost } from "@/app/api/accuracy/coverage/route";
import { POST as ideatePost } from "@/app/api/accuracy/ideate/route";
import AccuracyReviewPage from "@/app/admin/accuracy/review/page";
import AccuracySourcesPage from "@/app/admin/accuracy/sources/page";
import AccuracyWorkspacesPage from "@/app/admin/accuracy/page";
import AccuracyLedgerPage from "@/app/admin/accuracy/ledger/page";
import { MissFlagInbox } from "@/components/accuracy/miss-flag-inbox";
import { SourceUploadForm } from "@/components/accuracy/source-upload-form";
import { ExtractOauthGateBanner, SourceExtractActions } from "@/components/accuracy/source-extract-actions";
import { ManualSourceForm } from "@/components/platform/manual-source-form";
import { ParseBlockPreview } from "@/components/accuracy/parse-block-preview";
import { LedgerNewClaimForm } from "@/components/accuracy/ledger-new-claim-form";
import { claimMetadata, getClaim } from "@/accuracy/store/claim-store";
import { listCoverageJoins } from "@/accuracy/store/coverage-store";
import { listCompletenessVerdicts } from "@/accuracy/store/completeness-verdict-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { listAccuracyRuns } from "@/accuracy/kernel/observability";
import { activeAccuracyModule } from "@/accuracy/kernel/registry";
import type { CallKind } from "@/accuracy/kernel/contracts";
import { setAiEnabled } from "@/modules/kernel/ai-switch";

registerAccuracyStack();

const ADMIN = "AI-off manual test";

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  return { org_id, workspace_id };
}

function req(url: string, method: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(res: Response) {
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Every element in a server-rendered tree, without rendering client components. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if ("props" in node && "type" in node) {
    const element = node as ReactElement<Record<string, unknown>>;
    out.push(element);
    for (const value of Object.values(element.props ?? {})) elements(value, out);
  }
  return out;
}

function hasTestId(tree: ReactElement[], id: string) {
  return tree.some((el) => (el.props as Record<string, unknown>)["data-testid"] === id);
}

async function agenticRuns(workspace_id: string) {
  const runs = await listAccuracyRuns(workspace_id, 500);
  const out = [];
  for (const run of runs) {
    const implementation = await activeAccuracyModule(run.call_kind as CallKind);
    if (implementation.manifest.agentic) out.push(run);
  }
  return out;
}

describe("the accuracy app with AI off", () => {
  beforeAll(async () => {
    await setAiEnabled({ enabled: false, actor_name: ADMIN, rationale: "AI off for the manual flow test" });
  });
  afterAll(async () => {
    await setAiEnabled({ enabled: true, actor_name: ADMIN, rationale: "restore after the manual flow test" });
  });

  it("runs the whole ledger by hand: gap + tactic, validate, priority, proposal, coverage, dates", async () => {
    const { workspace_id } = await freshWorkspace("ai-off-manual");

    const gapRes = await call(
      await claimsPost(
        req("/api/accuracy/claims", "POST", {
          workspace_id,
          claim_type: "gap",
          statement: "No prospective data on pneumonitis in community practice",
          rationale: "From the advisory board notes",
          fields: { external_id: "G-01" },
        }),
      ),
    );
    expect(gapRes.status).toBe(200);
    const gapId = (gapRes.json.claim as { id: string }).id;

    const tacticRes = await call(
      await claimsPost(
        req("/api/accuracy/claims", "POST", {
          workspace_id,
          claim_type: "tactic",
          statement: "Community oncology pneumonitis registry",
          rationale: "Existing tactic from the brand plan",
          fields: { type: TACTIC_TYPE },
        }),
      ),
    );
    expect(tacticRes.status).toBe(200);
    const tacticId = (tacticRes.json.claim as { id: string }).id;

    const validated = await call(
      await validatePost(
        req("/api/accuracy/claims/validate", "POST", {
          workspace_id,
          claim_ids: [gapId, tacticId],
          action: "validate",
          rationale: "Checked against the source by hand",
        }),
      ),
    );
    expect(validated.status).toBe(200);

    const priority = await call(
      await priorityPost(
        req("/api/accuracy/claims/priority", "POST", {
          workspace_id,
          claim_id: gapId,
          priority: "high",
          rationale: "Top unmet need for the brand",
        }),
      ),
    );
    expect(priority.status).toBe(200);
    expect(claimMetadata((await getClaim(workspace_id, gapId))!).priority).toBe("high");

    const proposal = await call(
      await ideatePost(
        req("/api/accuracy/ideate", "POST", {
          workspace_id,
          gap_id: gapId,
          title: "Prospective pneumonitis cohort study",
          rationale: "Fills the high-priority open gap",
          start: "2027-01-01",
          end: "2027-12-31",
        }),
      ),
    );
    expect(proposal.status).toBe(200);
    expect(proposal.json.mode).toBe("manual");
    const proposed = await getClaim(workspace_id, String(proposal.json.tactic_id));
    expect(proposed?.status).toBe("proposed");

    const coverage = await call(
      await coveragePost(
        req("/api/accuracy/coverage", "POST", {
          workspace_id,
          gap_id: gapId,
          tactic_id: tacticId,
          overall: "partial",
          rationale: "Registry covers part of the need",
        }),
      ),
    );
    expect(coverage.status).toBe(200);
    const joins = await listCoverageJoins(workspace_id);
    expect(joins.some((row) => row.gap_id === gapId && row.tactic_id === tacticId && row.overall === "partial")).toBe(
      true,
    );

    const dates = await call(
      await claimsPatch(
        req("/api/accuracy/claims", "PATCH", {
          workspace_id,
          claim_id: tacticId,
          patch: { start: "2027-02-01", end: "2027-09-30" },
          rationale: "Schedule agreed with the study team",
        }),
      ),
    );
    expect(dates.status).toBe(200);
    const meta = claimMetadata((await getClaim(workspace_id, tacticId))!);
    expect(meta.start).toBe("2027-02-01");
    expect(meta.end).toBe("2027-09-30");

    // Nothing in the manual flow asked a model.
    expect(await agenticRuns(workspace_id)).toHaveLength(0);
  });

  it("review page shows the AI-off note and never runs the completeness audit", async () => {
    const { org_id, workspace_id } = await freshWorkspace("ai-off-review-page");
    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename: "notes.txt",
      mime: "text/plain",
      checksum: `chk-${Date.now()}`,
      doc_role: "medical",
    });
    await persistParseBlocks({
      workspace_id,
      source_file_id: source.id,
      parser: "local_structured",
      blocks: [
        {
          id: `${source.id}-B001`,
          source_file_id: source.id,
          index: 0,
          kind: "prose",
          heading: null,
          text: "Physicians lack guidance on dose holds for pneumonitis.",
        },
      ],
    });
    const runsBefore = (await listAccuracyRuns(workspace_id, 500)).length;
    const tree = elements(await AccuracyReviewPage({ searchParams: Promise.resolve({ workspace_id }) }));
    expect(hasTestId(tree, "review-ai-off")).toBe(true);
    expect(tree.some((el) => el.type === MissFlagInbox)).toBe(false);
    expect((await listAccuracyRuns(workspace_id, 500)).length).toBe(runsBefore);
    expect(await listCompletenessVerdicts(workspace_id)).toHaveLength(0);
  });

  it("sources page hides upload, hand-typed sources and extract, and lists sources read-only", async () => {
    const { org_id, workspace_id } = await freshWorkspace("ai-off-sources-page");
    await insertSourceFile({
      workspace_id,
      org_id,
      filename: "deck.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      checksum: `chk-${Date.now()}`,
      doc_role: "medical",
    });
    const tree = elements(await AccuracySourcesPage({ searchParams: Promise.resolve({ workspace_id }) }));
    expect(hasTestId(tree, "sources-ai-off")).toBe(true);
    for (const hidden of [SourceUploadForm, ManualSourceForm, SourceExtractActions, ExtractOauthGateBanner]) {
      expect(tree.some((el) => el.type === hidden)).toBe(false);
    }
    const previews = tree.filter((el) => el.type === ParseBlockPreview);
    expect(previews).toHaveLength(1);
    expect((previews[0].props as { edit?: unknown }).edit).toBeUndefined();
  });

  it("first screen leads with Add gaps / Add tactics", async () => {
    const { workspace_id } = await freshWorkspace("ai-off-first-screen");
    const landing = elements(await AccuracyWorkspacesPage({ searchParams: Promise.resolve({}) }));
    expect(hasTestId(landing, "accuracy-manual-start")).toBe(true);
    const hrefs = landing.map((el) => (el.props as { href?: unknown }).href).filter(Boolean);
    expect(hrefs).toContain(`/admin/accuracy/ledger?workspace_id=${encodeURIComponent(workspace_id)}&add=gap`);
    expect(hrefs).toContain(`/admin/accuracy/ledger?workspace_id=${encodeURIComponent(workspace_id)}&add=tactic`);

    const ledger = elements(
      await AccuracyLedgerPage({ searchParams: Promise.resolve({ workspace_id, add: "tactic" }) }),
    );
    const forms = ledger.filter((el) => el.type === LedgerNewClaimForm);
    expect(forms).toHaveLength(1);
    expect((forms[0].props as { initialKind?: unknown }).initialKind).toBe("tactic");
  });
});

const TACTIC_TYPE = "registry" as const;
