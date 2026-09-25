import { describe, expect, it } from "vitest";
import {
  claimChapterSlug,
  claimMatchesLedgerFilters,
  claimSiSlugs,
  filterLedgerClaims,
  ledgerFilterFacets,
  ledgerHref,
  parseLedgerFilters,
  siThemeFromGapId,
  UNASSIGNED_FILTER,
} from "@/accuracy/domain/ledger-filters";
import {
  chromePlanLabelStatus,
  chromeStackCaption,
  normalizePlanLabel,
  planLabelFromPack,
  workspacePlanLabel,
} from "@/accuracy/domain/plan-label";
import { GET as workspacesGet, POST as workspacesPost } from "@/app/api/accuracy/workspaces/route";
import { claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { getWorkspace, createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { seedWorkspaceFromGold } from "@/accuracy/store/seed-from-gold";
import { ensureAccuracySchema } from "@/accuracy/store/db";
import { getReferencePack } from "@/accuracy/eval/reference-gold";

const bgbGaps = [
  {
    id: "gap-ad",
    claim_type: "gap",
    metadata: { external_id: "NSCLC_AD_01", si_theme: "biomarkers" },
    statement: "MTAP prevalence",
  },
  {
    id: "gap-ce",
    claim_type: "gap",
    metadata: { external_id: "NSCLC_CE_01" },
    statement: "Long-term differentiation",
  },
  {
    id: "gap-hi",
    claim_type: "gap",
    metadata: { external_id: "NSCLC_HI_02" },
    statement: "Cost effectiveness of MTAP testing",
  },
];

const tisleGaps = [
  {
    id: "gap-escc",
    claim_type: "gap",
    metadata: { chapter: "advanced_metastatic_escc" },
    statement: "Need ESCC 1L data",
  },
  {
    id: "gap-lung",
    claim_type: "gap",
    metadata: { chapter: "across_lung" },
    statement: "Need lung sequencing data",
  },
  {
    id: "gap-none",
    claim_type: "gap",
    metadata: {},
    statement: "Unscoped residual",
  },
];

describe("ledger SI / chapter filters", () => {
  it("maps BGB NSCLC_* ids to SI themes (Biomarkers / Differentiation / Health impact)", () => {
    expect(siThemeFromGapId("NSCLC_AD_01")?.slug).toBe("biomarkers");
    expect(siThemeFromGapId("NSCLC_CE_04")?.label).toBe("Differentiation");
    expect(siThemeFromGapId("NSCLC_GA_01")?.slug).toBe("generating-awareness");
    expect(siThemeFromGapId("NSCLC_HI_15")?.slug).toBe("health-impact");
    expect(claimSiSlugs(bgbGaps[1]!)).toEqual(["differentiation"]);
  });

  it("filters BGB gaps by SI and keeps card-shaped claims (not a table extract)", () => {
    const filtered = filterLedgerClaims(bgbGaps, { si: "differentiation" });
    expect(filtered.map((c) => c.id)).toEqual(["gap-ce"]);
    expect(filterLedgerClaims(bgbGaps, { si: "CE" }).map((c) => c.id)).toEqual(["gap-ce"]);
    expect(filterLedgerClaims(bgbGaps, { si: "biomarkers" }).map((c) => c.id)).toEqual(["gap-ad"]);
  });

  it("filters Tisle gaps by indication chapter", () => {
    expect(claimChapterSlug(tisleGaps[0]!)).toBe("advanced_metastatic_escc");
    const escc = filterLedgerClaims(tisleGaps, { chapter: "escc" });
    expect(escc.map((c) => c.id)).toEqual(["gap-escc"]);
    const lung = filterLedgerClaims(tisleGaps, { chapter: "across_lung" });
    expect(lung.map((c) => c.id)).toEqual(["gap-lung"]);
  });

  it("ANDs chapter + SI and supports unassigned", () => {
    const mixed = [
      {
        id: "both",
        metadata: { chapter: "across_lung", external_id: "NSCLC_CE_01" },
      },
      {
        id: "chapter-only",
        metadata: { chapter: "across_lung" },
      },
      { id: "neither", metadata: {} },
    ];
    expect(filterLedgerClaims(mixed, { chapter: "across_lung", si: "differentiation" }).map((c) => c.id)).toEqual([
      "both",
    ]);
    expect(filterLedgerClaims(tisleGaps, { chapter: UNASSIGNED_FILTER }).map((c) => c.id)).toEqual([
      "gap-none",
    ]);
    expect(claimMatchesLedgerFilters(tisleGaps[2]!, { chapter: "escc" })).toBe(false);
  });

  it("lets tactics inherit SI from linked NSCLC gap_ids", () => {
    const tactic = {
      id: "tac-1",
      claim_type: "tactic",
      metadata: { gap_ids: ["NSCLC_HI_07", "NSCLC_CE_01"] },
    };
    expect(claimSiSlugs(tactic).sort()).toEqual(["differentiation", "health-impact"]);
    expect(filterLedgerClaims([tactic], { si: "health-impact" })).toHaveLength(1);
    expect(filterLedgerClaims([tactic], { si: "biomarkers" })).toHaveLength(0);
  });

  it("builds chapter vs SI facets for BeOne patterns and ledger URLs", () => {
    const bgbFacets = ledgerFilterFacets(bgbGaps);
    expect(bgbFacets.chapters).toEqual([]);
    expect(bgbFacets.siThemes.map((f) => f.slug).sort()).toEqual([
      "biomarkers",
      "differentiation",
      "health-impact",
    ]);

    const tisleFacets = ledgerFilterFacets(tisleGaps);
    expect(tisleFacets.siThemes).toEqual([]);
    expect(tisleFacets.chapters.some((f) => f.slug === "advanced_metastatic_escc")).toBe(true);
    expect(tisleFacets.chapters.some((f) => f.slug === UNASSIGNED_FILTER)).toBe(true);

    expect(ledgerHref("ws_1", { si: "differentiation" })).toBe(
      "/admin/accuracy/ledger?workspace_id=ws_1&si=differentiation",
    );
    expect(parseLedgerFilters({ chapter: "ESCC", si: "CE" })).toEqual({
      chapter: "advanced_metastatic_escc",
      si: "differentiation",
    });
  });
});

describe("workspace plan_label (IEP vs IEGP)", () => {
  it("labels BGB as IEP and Tisle as IEGP for chrome copy", () => {
    expect(planLabelFromPack(getReferencePack("beone-bgb-58067-prmt5i"))).toBe("IEP");
    expect(planLabelFromPack(getReferencePack("beone-tislelizumab-iegp"))).toBe("IEGP");
    expect(chromeStackCaption("IEP")).toBe("Multi-tenant IEP stack");
    expect(chromeStackCaption("IEGP")).toBe("Multi-tenant IEGP stack");
    expect(chromePlanLabelStatus("IEP")).toBe("Plan type IEP");
    expect(chromePlanLabelStatus(null)).toBeNull();
    expect(normalizePlanLabel("integrated_evidence_plan")).toBe("IEP");
  });

  it("persists plan_label on create and returns it from the workspaces API", async () => {
    await ensureAccuracySchema();
    const org_id = await createOrganization(`org-plan-${Date.now()}`);
    const workspace_id = await createWorkspace({
      org_id,
      name: "BGB IEP workspace",
      slug: `iep-${Date.now()}`,
      plan_label: "IEP",
    });
    const row = await getWorkspace(workspace_id);
    expect(workspacePlanLabel(row)).toBe("IEP");

    const listed = await workspacesGet(
      new Request("http://localhost/api/accuracy/workspaces?workspace_id=" + workspace_id),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { workspace: { plan_label: string | null } };
    expect(body.workspace.plan_label).toBe("IEP");

    const created = await workspacesPost(
      new Request("http://localhost/api/accuracy/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Tisle plan", slug: `iegp-${Date.now()}`, plan_label: "IEGP" }),
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { ok: boolean; plan_label: string; workspace_id: string };
    expect(createdBody.ok).toBe(true);
    expect(createdBody.plan_label).toBe("IEGP");
    const createdRow = await getWorkspace(createdBody.workspace_id);
    expect(workspacePlanLabel(createdRow)).toBe("IEGP");
  });

  it("seeds BGB gold with IEP + SI and Tisle gold with IEGP + chapter", async () => {
    const bgb = await seedWorkspaceFromGold({
      packId: "beone-bgb-58067-prmt5i",
      workspaceName: "Filter seed BGB",
      parseSource: false,
    });
    expect(workspacePlanLabel(await getWorkspace(bgb.workspace_id))).toBe("IEP");
    const bgbClaims = await listClaims(bgb.workspace_id, { limit: 200 });
    const bgbGapsSeeded = bgbClaims.filter((c) => c.claim_type === "gap");
    expect(bgbGapsSeeded.some((c) => claimMetadata(c).si_theme === "differentiation")).toBe(true);
    expect(bgbGapsSeeded.some((c) => claimMetadata(c).si_theme === "biomarkers")).toBe(true);
    expect(filterLedgerClaims(bgbGapsSeeded, { si: "differentiation" }).length).toBe(5);

    const tisle = await seedWorkspaceFromGold({
      packId: "beone-tislelizumab-iegp",
      workspaceName: "Filter seed Tisle",
      parseSource: false,
    });
    expect(workspacePlanLabel(await getWorkspace(tisle.workspace_id))).toBe("IEGP");
    const tisleClaims = await listClaims(tisle.workspace_id, { limit: 200 });
    const tisleGapsSeeded = tisleClaims.filter((c) => c.claim_type === "gap");
    expect(tisleGapsSeeded.some((c) => claimMetadata(c).chapter === "advanced_metastatic_escc")).toBe(
      true,
    );
    const escc = filterLedgerClaims(tisleGapsSeeded, { chapter: "advanced_metastatic_escc" });
    expect(escc.length).toBeGreaterThan(0);
    expect(escc.every((c) => claimChapterSlug(c) === "advanced_metastatic_escc")).toBe(true);
  }, 60_000);
});
