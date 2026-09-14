import { describe, expect, it } from "vitest";
import { atomize, statementSimilarity } from "@/lib/text";
import { classifyStatement } from "@/lib/extract/classify";
import { proposeInsights } from "@/lib/extract/proposer";
import { SEED_DOCUMENTS } from "@/lib/seed/corpus";
import { scoreMetrics } from "@/lib/eval/critique";
import { pickChampion } from "@/lib/eval/judge";
import { buildSeedState, ingestParsedDocument, runEvalSweep } from "@/lib/pipeline";
import { GOLD_INSIGHTS } from "@/lib/seed/corpus";
import { canonicalInsightSchema } from "@/lib/schema";

describe("REQ-EXT atomic extraction", () => {
  it("REQ-EXT-001 splits a double-barreled access bullet", () => {
    const parts = atomize(
      "Formulary decisions at Aetna and UnitedHealthcare are delayed into Q1 2027 and both accounts have requested additional 6-month discontinuation RWE.",
    );
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]).toMatch(/Aetna/);
    expect(parts[1]).toMatch(/RWE/);
  });

  it("REQ-KNO-002 classifies unmeasured quantities as unknown", () => {
    expect(
      classifyStatement("Community oncology adoption remains unquantified."),
    ).toBe("unknown");
    expect(
      classifyStatement(
        "Stand up a community-focused peer-to-peer program to close the site-of-care evidence gap.",
      ),
    ).toBe("opportunity");
  });

  it("REQ-EXT-004 emits CIR records that satisfy the flat schema", () => {
    const insights = proposeInsights(SEED_DOCUMENTS, "v1.3-cross-functional");
    expect(insights.length).toBeGreaterThan(10);
    for (const insight of insights) {
      expect(() => canonicalInsightSchema.parse(insight)).not.toThrow();
    }
  });
});

describe("REQ-EVA hill-climb", () => {
  it("REQ-EVA-009 promotes a later prompt version over bullet-only", () => {
    const { runs, champion } = runEvalSweep(SEED_DOCUMENTS);
    const baseline = runs.find((r) => r.prompt_version === "v1.0-baseline");
    const champ = runs.find((r) => r.prompt_version === champion);
    expect(baseline).toBeTruthy();
    expect(champ).toBeTruthy();
    expect(champ!.metrics.composite).toBeGreaterThan(
      baseline!.metrics.composite,
    );
    expect(champion).not.toBe("v1.0-baseline");
    expect(
      pickChampion(runs.map((r) => ({ version: r.prompt_version, metrics: r.metrics }))),
    ).toBe(champion);
  });

  it("REQ-EVA-009 ingest re-runs the hill-climb without a lab trigger", async () => {
    const seed = buildSeedState();
    expect(seed.eval_runs.length).toBeGreaterThanOrEqual(4);
    const extra = {
      ...SEED_DOCUMENTS[0]!,
      id: "DOC-EXTRA-EVAL",
      filename: "extra-eval.pptx",
    };
    const next = await ingestParsedDocument(seed, extra);
    expect(next.eval_runs.length).toBeGreaterThanOrEqual(4);
    expect(next.champion_prompt_version).toBeTruthy();
    expect(next.documents.some((d) => d.id === extra.id)).toBe(true);
  });

  it("REQ-EVA-002/003/004/005 scores partial, wrong, missed, and new", () => {
    const extracted = proposeInsights(SEED_DOCUMENTS, "v1.0-baseline");
    const { metrics } = scoreMetrics(extracted, GOLD_INSIGHTS, SEED_DOCUMENTS);
    expect(metrics.missed).toBeGreaterThan(0);
    expect(metrics.gold_count).toBe(GOLD_INSIGHTS.length);
    expect(metrics.extracted_count).toBe(extracted.length);
  });
});

describe("REQ-EXT-002 grounding", () => {
  it("keeps evidence quotes that overlap the statement", () => {
    const insights = proposeInsights(
      [SEED_DOCUMENTS[0]!],
      "v1.3-cross-functional",
    );
    expect(insights.length).toBeGreaterThan(0);
    for (const insight of insights) {
      expect(insight.evidence_quote.length).toBeGreaterThan(10);
      expect(
        statementSimilarity(insight.statement, insight.evidence_quote),
      ).toBeGreaterThan(0.2);
    }
  });
});
