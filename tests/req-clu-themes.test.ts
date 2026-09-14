import { describe, expect, it } from "vitest";
import { assignThemes, linkInsightToThemes } from "@/lib/cluster/cluster";
import type { CanonicalInsight } from "@/lib/schema";

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
    theme_ids: [],
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

describe("REQ-CLU-001 catalog multi-label linkage", () => {
  it("REQ-CLU-002 links one insight to Access and Evidence without copying it", () => {
    const record = insight(
      "Formulary decisions at Aetna are delayed into Q1 2027 because both accounts requested 6-month discontinuation RWE.",
    );
    const links = linkInsightToThemes(record);
    const ids = links.map((l) => l.theme_id);
    expect(ids).toContain("THEME-ACCESS");
    expect(ids).toContain("THEME-EVIDENCE");
    expect(new Set(links.map((l) => l.insight_id)).size).toBe(1);
  });

  it("REQ-CLU-003 keeps a single CIR row when the same insight hangs off two themes", () => {
    const records = [
      insight(
        "Payers will impose a step edit unless CNS and discontinuation data are in the AMCP dossier.",
        { id: "INS-A", stakeholder_function: "market_access" },
      ),
      insight("NX-441 is expected to file in 2027 and will contest post-osi share.", {
        id: "INS-B",
      }),
    ];
    const { insights, themes, theme_links } = assignThemes(records);
    expect(insights).toHaveLength(2);
    const access = themes.find((t) => t.id === "THEME-ACCESS");
    const evidence = themes.find((t) => t.id === "THEME-EVIDENCE");
    expect(access?.insight_ids).toContain("INS-A");
    expect(evidence?.insight_ids).toContain("INS-A");
    expect(insights.filter((i) => i.id === "INS-A")).toHaveLength(1);
    expect(theme_links.filter((l) => l.insight_id === "INS-A").length).toBeGreaterThan(
      1,
    );
  });

  it("REQ-CLU-004 does not smear a competitive threat into Access", () => {
    const links = linkInsightToThemes(
      insight(
        "Next-generation EGFR-MET bispecific NX-441 is expected to file in 2027.",
      ),
    );
    expect(links.map((l) => l.theme_id)).toContain("THEME-COMPETITIVE");
    expect(links.map((l) => l.theme_id)).not.toContain("THEME-ACCESS");
  });

  it("REQ-CLU-005 sends unmatched claims to residual instead of inventing a blob", () => {
    const links = linkInsightToThemes(
      insight("The weather in Basel was unseasonably mild during the advisory."),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.theme_id).toBe("THEME-RESIDUAL");
    expect(links[0]?.method).toBe("residual");
  });
});
