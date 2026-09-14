import { describe, expect, it } from "vitest";
import { groundAgainstSource, proposeInsights } from "@/lib/extract/proposer";
import { pairExtractedToGold } from "@/lib/eval/critique";
import {
  GOLD_INSIGHTS,
  SEED_DOCUMENTS,
  THEME_CATALOG,
} from "@/lib/seed/corpus";
import { STAKEHOLDER_FUNCTIONS } from "@/lib/schema";
import { statementSimilarity } from "@/lib/text";

const GROUND = 0.28;

describe("REQ-EVA-001 gold coverage", () => {
  it("covers every stakeholder function, class, and a must_find mix", () => {
    const functions = new Set(GOLD_INSIGHTS.map((g) => g.stakeholder_function));
    for (const fn of STAKEHOLDER_FUNCTIONS) {
      expect(functions.has(fn)).toBe(true);
    }
    const classes = new Set(GOLD_INSIGHTS.map((g) => g.classification));
    expect(classes.has("known")).toBe(true);
    expect(classes.has("unknown")).toBe(true);
    expect(classes.has("opportunity")).toBe(true);
    expect(GOLD_INSIGHTS.filter((g) => g.must_find).length).toBeGreaterThan(60);
    expect(GOLD_INSIGHTS.filter((g) => !g.must_find).length).toBeGreaterThan(5);
  });

  it("keeps gold ids unique and statements atomic", () => {
    const ids = GOLD_INSIGHTS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const statements = GOLD_INSIGHTS.map((g) => g.statement);
    expect(new Set(statements).size).toBe(statements.length);
    expect(
      GOLD_INSIGHTS.every((g) => !/\sand both\s/i.test(g.statement)),
    ).toBe(true);
  });

  it("grounds every gold row in its own source document", () => {
    const catalogIds = new Set(THEME_CATALOG.map((t) => t.id));
    for (const gold of GOLD_INSIGHTS) {
      const doc = SEED_DOCUMENTS.find((d) => d.id === gold.source_document_id);
      expect(doc).toBeTruthy();
      const score = groundAgainstSource(gold.statement, [doc!]);
      expect(score, gold.id).toBeGreaterThanOrEqual(GROUND);
      expect(gold.theme_ids.length).toBeGreaterThan(0);
      expect(gold.theme_ids.every((id) => catalogIds.has(id))).toBe(true);
    }
  });

  it("includes multi-theme, residual, table, chart, and figure scenarios", () => {
    expect(GOLD_INSIGHTS.some((g) => g.theme_ids.length >= 2)).toBe(true);
    expect(
      GOLD_INSIGHTS.some((g) => g.theme_ids.includes("THEME-RESIDUAL")),
    ).toBe(true);

    const byDoc = (id: string) =>
      GOLD_INSIGHTS.filter((g) => g.source_document_id === id);
    expect(byDoc("DOC-HEOR-001").length).toBeGreaterThan(5);
    expect(byDoc("DOC-REG-001").length).toBeGreaterThan(5);

    const heorDoc = SEED_DOCUMENTS.find((d) => d.id === "DOC-HEOR-001")!;
    expect(heorDoc.blocks.some((b) => b.kind === "table_cell")).toBe(true);
    const commercial = SEED_DOCUMENTS.find((d) => d.id === "DOC-COM-001")!;
    expect(commercial.blocks.some((b) => b.kind === "chart")).toBe(true);
    const medical = SEED_DOCUMENTS.find((d) => d.id === "DOC-MED-001")!;
    expect(medical.blocks.some((b) => b.kind === "figure")).toBe(true);
  });

  it("does not let two gold rows collapse into one lexical alias", () => {
    for (let i = 0; i < GOLD_INSIGHTS.length; i += 1) {
      for (let j = i + 1; j < GOLD_INSIGHTS.length; j += 1) {
        const a = GOLD_INSIGHTS[i]!;
        const b = GOLD_INSIGHTS[j]!;
        const sim = statementSimilarity(a.statement, b.statement);
        expect(sim, `${a.id} vs ${b.id}`).toBeLessThan(0.58);
      }
    }
  });

  it("leaves room for missed / new on the baseline extractor", () => {
    const extracted = proposeInsights(SEED_DOCUMENTS, "v1.0-baseline");
    const { pairs, missed } = pairExtractedToGold(
      extracted,
      GOLD_INSIGHTS,
      SEED_DOCUMENTS,
    );
    expect(missed.length).toBeGreaterThan(10);
    expect(pairs.some((p) => p.kind === "exact")).toBe(true);
  });
});
