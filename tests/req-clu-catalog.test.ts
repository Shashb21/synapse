import { describe, expect, it } from "vitest";
import {
  acceptProposal,
  proposeCatalogChanges,
  rejectProposal,
} from "@/lib/cluster/catalog-evolution";
import { assignThemes } from "@/lib/cluster/cluster";
import { buildSeedState, seedCatalog } from "@/lib/pipeline";
import type { CanonicalInsight, EngineState } from "@/lib/schema";
import { THEME_CATALOG } from "@/lib/seed/corpus";

function insight(
  statement: string,
  extra?: Partial<CanonicalInsight>,
): CanonicalInsight {
  return {
    id: extra?.id ?? "INS-TEST",
    statement,
    evidence_quote: statement,
    source_document_id: extra?.source_document_id ?? "DOC-X",
    source_location: { kind: "slide", ref: "Slide 1" },
    stakeholder_function: extra?.stakeholder_function ?? "commercial",
    theme_ids: extra?.theme_ids ?? [],
    confidence: 0.8,
    classification: extra?.classification ?? "known",
    knowledge_state: {
      corroborated_by: [],
      contradicted_by: [],
      evidence_strength: "single_source",
    },
    tags: [],
    extracted_at: "2026-09-14T00:00:00.000Z",
    extractor_prompt_version: "v1.3-cross-functional",
    status: "accepted",
    ...extra,
  };
}

function engine(
  insights: CanonicalInsight[],
  catalog: EngineState["catalog"],
  extra?: Partial<EngineState>,
): EngineState {
  const clustered = assignThemes(insights, catalog);
  const proposals = extra?.catalog_proposals ?? proposeCatalogChanges(
    clustered.insights,
    catalog,
  );
  return {
    catalog,
    catalog_proposals: proposals,
    insights: clustered.insights,
    themes: clustered.themes,
    theme_links: clustered.theme_links,
    documents: [],
    gold: [],
    eval_runs: [],
    champion_prompt_version: "v1.3-cross-functional",
    asset: {
      name: "Velmara",
      molecule: "velmaratinib",
      indication: "x",
      as_of: "2026-09-14",
    },
    ...extra,
  };
}

describe("REQ-CLU catalog evolution", () => {
  it("REQ-CLU-007 proposes a new theme when unassigned CIR cluster", () => {
    const { insights } = assignThemes(
      [
        insight(
          "The FDA PDUFA date for the velmaratinib US launch remains unspecified.",
          { id: "INS-P1", source_document_id: "DOC-A" },
        ),
        insight(
          "FDA has not specified a PDUFA date for the velmaratinib US launch.",
          { id: "INS-P2", source_document_id: "DOC-B" },
        ),
      ],
      seedCatalog(),
    );
    expect(insights.every((i) => i.theme_ids.includes("THEME-RESIDUAL"))).toBe(
      true,
    );
    const proposals = proposeCatalogChanges(insights, seedCatalog());
    const emerge = proposals.find((p) => p.kind === "emerge");
    expect(emerge).toBeTruthy();
    expect(emerge!.insight_ids).toHaveLength(2);
    expect(emerge!.status).toBe("proposed");
  });

  it("REQ-CLU-008 proposes a split when one theme holds two decision objects", () => {
    const members = [
      insight("Aetna formulary decision delayed into Q1 pending AMCP dossier.", {
        id: "INS-S1",
        theme_ids: ["THEME-ACCESS"],
      }),
      insight("UnitedHealthcare step edit remains on Medicaid formularies.", {
        id: "INS-S2",
        theme_ids: ["THEME-ACCESS"],
      }),
      insight("Unbranded campaign recall is 64% among community oncologists.", {
        id: "INS-S3",
        theme_ids: ["THEME-ACCESS"],
      }),
      insight("Email open rate and NPS lag on the unbranded HCP campaign.", {
        id: "INS-S4",
        theme_ids: ["THEME-ACCESS"],
      }),
    ];
    const proposals = proposeCatalogChanges(members, seedCatalog());
    const split = proposals.find((p) => p.kind === "split");
    expect(split).toBeTruthy();
    expect(split!.parent_theme_id).toBe("THEME-ACCESS");
    expect(split!.insight_ids.length).toBeGreaterThanOrEqual(2);
  });

  it("REQ-CLU-007 accept grows the catalog and does not copy CIR rows", () => {
    const catalog = seedCatalog();
    const raw = [
      insight(
        "The FDA PDUFA date for the velmaratinib US launch remains unspecified.",
        { id: "INS-P1", source_document_id: "DOC-A" },
      ),
      insight(
        "FDA has not specified a PDUFA date for the velmaratinib US launch.",
        { id: "INS-P2", source_document_id: "DOC-B" },
      ),
    ];
    const state = engine(raw, catalog);
    const emerge = state.catalog_proposals.find((p) => p.kind === "emerge")!;
    const next = acceptProposal(state, emerge.id);
    const added = next.catalog.find(
      (c) => !catalog.some((prior) => prior.id === c.id),
    );
    expect(next.catalog.length).toBe(catalog.length + 1);
    expect(next.insights).toHaveLength(2);
    expect(added).toBeTruthy();
    expect(
      next.insights.every((i) => i.theme_ids.includes(added!.id)),
    ).toBe(true);
    expect(
      next.catalog_proposals.find((p) => p.id === emerge.id)?.status,
    ).toBe("accepted");
    expect(THEME_CATALOG.some((t) => t.id === "THEME-RESIDUAL")).toBe(true);
  });

  it("REQ-CLU-008 accept appends a child and keeps the parent; CIR rows are not copied", () => {
    const catalog = seedCatalog();
    const members = [
      insight("Aetna formulary decision delayed into Q1 pending AMCP dossier.", {
        id: "INS-S1",
        theme_ids: ["THEME-ACCESS"],
      }),
      insight("UnitedHealthcare step edit remains on Medicaid formularies.", {
        id: "INS-S2",
        theme_ids: ["THEME-ACCESS"],
      }),
      insight("Unbranded campaign recall is 64% among community oncologists.", {
        id: "INS-S3",
        theme_ids: ["THEME-ACCESS"],
      }),
      insight("Email open rate and NPS lag on the unbranded HCP campaign.", {
        id: "INS-S4",
        theme_ids: ["THEME-ACCESS"],
      }),
    ];
    const state = engine(members, catalog, {
      insights: members,
      catalog_proposals: proposeCatalogChanges(members, catalog),
      themes: [],
      theme_links: members.flatMap((m) => [
        {
          insight_id: m.id,
          theme_id: "THEME-ACCESS",
          score: 1,
          role: "primary" as const,
          method: "ontology" as const,
        },
      ]),
    });
    const split = state.catalog_proposals.find((p) => p.kind === "split")!;
    const next = acceptProposal(state, split.id);
    expect(next.catalog.length).toBe(catalog.length + 1);
    expect(next.catalog.some((c) => c.id === "THEME-ACCESS")).toBe(true);
    expect(next.catalog.some((c) => c.parent_theme_id === "THEME-ACCESS")).toBe(
      true,
    );
    expect(next.insights).toHaveLength(4);
    const child = next.catalog.find((c) => c.parent_theme_id === "THEME-ACCESS")!;
    expect(
      split.insight_ids.every((id) =>
        next.insights.find((i) => i.id === id)?.theme_ids.includes(child.id),
      ),
    ).toBe(true);
    expect(
      split.insight_ids.every((id) =>
        next.insights.find((i) => i.id === id)?.theme_ids.includes("THEME-ACCESS"),
      ),
    ).toBe(true);
  });

  it("REQ-CLU-007 reject does not re-propose the same id", () => {
    const catalog = seedCatalog();
    const raw = [
      insight(
        "The FDA PDUFA date for the velmaratinib US launch remains unspecified.",
        { id: "INS-P1", source_document_id: "DOC-A" },
      ),
      insight(
        "FDA has not specified a PDUFA date for the velmaratinib US launch.",
        { id: "INS-P2", source_document_id: "DOC-B" },
      ),
    ];
    const state = engine(raw, catalog);
    const emerge = state.catalog_proposals.find((p) => p.kind === "emerge")!;
    const rejected = rejectProposal(state, emerge.id);
    expect(
      rejected.catalog_proposals.find((p) => p.id === emerge.id)?.status,
    ).toBe("rejected");
    const again = proposeCatalogChanges(
      rejected.insights,
      catalog,
      rejected.catalog_proposals,
    );
    expect(again.find((p) => p.id === emerge.id)?.status).toBe("rejected");
    expect(
      again.filter((p) => p.status === "proposed" && p.id === emerge.id),
    ).toHaveLength(0);
  });

  it("seed queues a live emerge from off-catalog REMS claims", () => {
    const state = buildSeedState();
    const emerge = state.catalog_proposals.find(
      (p) => p.kind === "emerge" && p.status === "proposed",
    );
    expect(emerge).toBeTruthy();
    expect(emerge!.sources).toBeGreaterThanOrEqual(2);
    expect(
      emerge!.insight_ids
        .map((id) => state.insights.find((i) => i.id === id)?.statement ?? "")
        .join(" "),
    ).toMatch(/REMS/i);
  });
});
