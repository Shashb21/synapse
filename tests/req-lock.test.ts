import { describe, expect, it } from "vitest";
import { critiqueInsights } from "@/lib/eval/critique";
import { judgeCandidate, proposeImprovement } from "@/lib/eval/judge";
import { classifyStatement } from "@/lib/extract/classify";
import { proposeInsights } from "@/lib/extract/proposer";
import { assignThemes, linkCrossDocument } from "@/lib/cluster/cluster";
import { buildSeedState, seedCatalog } from "@/lib/pipeline";
import { GOLD_INSIGHTS, SEED_DOCUMENTS } from "@/lib/seed/corpus";
import type { CanonicalInsight, EvalMetrics } from "@/lib/schema";

function metrics(partial: Partial<EvalMetrics>): EvalMetrics {
  return {
    precision: 0.8,
    recall: 0.8,
    f1: 0.8,
    partial_rate: 0.05,
    wrong_rate: 0.02,
    missed_rate: 0.1,
    new_rate: 0.05,
    composite: 0.8,
    matched: 10,
    partial: 1,
    wrong: 0,
    missed: 2,
    novel: 1,
    extracted_count: 12,
    gold_count: 12,
    ...partial,
  };
}

describe("REQ lock coverage", () => {
  it("REQ-ING-005 persists stakeholder function, parser, and full text", () => {
    const state = buildSeedState();
    expect(state.documents.length).toBeGreaterThanOrEqual(5);
    for (const doc of state.documents) {
      expect(doc.stakeholder_function).toBeTruthy();
      expect(doc.parser).toBe("seed");
      expect(doc.fullText.length).toBeGreaterThan(40);
      expect(doc.blocks.length).toBeGreaterThan(0);
    }
  });

  it("REQ-EXT-003 tags stakeholder function from the source document", () => {
    const medical = proposeInsights(
      SEED_DOCUMENTS.filter((d) => d.stakeholder_function === "medical_affairs"),
      "v1.3-cross-functional",
    );
    expect(medical.length).toBeGreaterThan(0);
    expect(medical.every((i) => i.stakeholder_function === "medical_affairs")).toBe(
      true,
    );
  });

  it("REQ-EXT-005 versions every CIR with the extractor prompt", () => {
    const insights = proposeInsights(SEED_DOCUMENTS, "v1.2-gap-sensitive");
    expect(insights.every((i) => i.extractor_prompt_version === "v1.2-gap-sensitive")).toBe(
      true,
    );
  });

  it("REQ-CLU-001 assigns from the versioned catalog, not a blob id", () => {
    const catalog = seedCatalog();
    const { themes } = assignThemes(
      proposeInsights(SEED_DOCUMENTS, "v1.3-cross-functional"),
      catalog,
    );
    const ids = new Set(themes.map((t) => t.id));
    expect(ids.has("THEME-ACCESS")).toBe(true);
    expect(ids.has("THEME-EVIDENCE")).toBe(true);
    expect([...ids].every((id) => id.startsWith("THEME-"))).toBe(true);
  });

  it("REQ-CLU-006 corroborates near-duplicate claims across documents", () => {
    const pair: CanonicalInsight[] = [
      {
        id: "INS-A",
        statement:
          "Aetna and UnitedHealthcare have requested additional 6-month discontinuation RWE.",
        evidence_quote: "requested additional 6-month discontinuation RWE",
        source_document_id: "DOC-A",
        source_location: { kind: "slide", ref: "Slide 4" },
        stakeholder_function: "commercial",
        theme_ids: [],
        confidence: 0.8,
        classification: "known",
        knowledge_state: {
          corroborated_by: [],
          contradicted_by: [],
          evidence_strength: "single_source",
        },
        tags: [],
        extracted_at: "2026-09-14T00:00:00.000Z",
        extractor_prompt_version: "v1.3-cross-functional",
        status: "accepted",
      },
      {
        id: "INS-B",
        statement:
          "Aetna and UnitedHealthcare have requested additional 6-month discontinuation RWE.",
        evidence_quote: "requested additional 6-month discontinuation RWE",
        source_document_id: "DOC-B",
        source_location: { kind: "slide", ref: "Slide 2" },
        stakeholder_function: "market_access",
        theme_ids: [],
        confidence: 0.8,
        classification: "known",
        knowledge_state: {
          corroborated_by: [],
          contradicted_by: [],
          evidence_strength: "single_source",
        },
        tags: [],
        extracted_at: "2026-09-14T00:00:00.000Z",
        extractor_prompt_version: "v1.3-cross-functional",
        status: "accepted",
      },
    ];
    const linked = linkCrossDocument(pair);
    expect(linked[0]!.knowledge_state.corroborated_by).toContain("INS-B");
    expect(linked[1]!.knowledge_state.corroborated_by).toContain("INS-A");
    expect(linked[0]!.knowledge_state.evidence_strength).not.toBe("single_source");
  });

  it("REQ-KNO-001 classifies a supported fact as known", () => {
    expect(
      classifyStatement(
        "PDUFA is 14 Mar 2027; US launch is assumed Q2 2027.",
      ),
    ).toBe("known");
  });

  it("REQ-EVA-001 gold is keyed to source documents", () => {
    const docIds = new Set(SEED_DOCUMENTS.map((d) => d.id));
    expect(GOLD_INSIGHTS.length).toBeGreaterThan(10);
    expect(GOLD_INSIGHTS.every((g) => docIds.has(g.source_document_id))).toBe(
      true,
    );
    expect(GOLD_INSIGHTS.some((g) => g.must_find)).toBe(true);
  });

  it("REQ-EVA-006 critique returns structured findings", () => {
    const extracted = proposeInsights(SEED_DOCUMENTS, "v1.0-baseline");
    const findings = critiqueInsights(extracted, GOLD_INSIGHTS, SEED_DOCUMENTS);
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.every((f) =>
        ["partial", "wrong", "missed", "new"].includes(f.kind),
      ),
    ).toBe(true);
    expect(findings.every((f) => f.statement.length > 0 && f.rationale.length > 0)).toBe(
      true,
    );
  });

  it("REQ-EVA-007/008 judge and improver emit a verdict and a prompt patch", () => {
    const verdict = judgeCandidate({
      candidateVersion: "v1.3-cross-functional",
      championVersion: "v1.0-baseline",
      candidate: metrics({ composite: 0.86, wrong_rate: 0.02, recall: 0.84 }),
      champion: metrics({ composite: 0.7, wrong_rate: 0.03, recall: 0.7 }),
    });
    expect(verdict.decision).toBe("promote");
    expect(verdict.safety_gate_passed).toBe(true);
    const patch = proposeImprovement({
      currentVersion: "v1.0-baseline",
      metrics: metrics({ partial_rate: 0.2, composite: 0.6 }),
    });
    expect(patch.recommended_prompt_version).not.toBe("v1.0-baseline");
    expect(patch.prompt_patch).toMatch(/ATOMICITY|Proposed patch/);
    expect(patch.rationale.length).toBeGreaterThan(0);
  });

  it("REQ-EVA-010 safety gate blocks a wrong-rate rise", () => {
    const verdict = judgeCandidate({
      candidateVersion: "v1.3-cross-functional",
      championVersion: "v1.2-gap-sensitive",
      candidate: metrics({ composite: 0.95, wrong_rate: 0.2, recall: 0.9 }),
      champion: metrics({ composite: 0.8, wrong_rate: 0.02, recall: 0.85 }),
    });
    expect(verdict.safety_gate_passed).toBe(false);
    expect(verdict.decision).toBe("regress");
  });
});
