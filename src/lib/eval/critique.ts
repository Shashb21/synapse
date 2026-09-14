import { groundAgainstSource } from "@/lib/extract/proposer";
import type {
  CanonicalInsight,
  CritiqueFinding,
  EvalMetrics,
  GoldInsight,
  ParsedDocument,
} from "@/lib/schema";
import { round4, statementSimilarity } from "@/lib/text";

const MATCH = 0.58;
const PARTIAL = 0.32;
const GROUND = 0.28;

export type Pairing = {
  extracted: CanonicalInsight;
  gold?: GoldInsight;
  similarity: number;
  kind: "exact" | "partial" | "wrong" | "new";
};

export function pairExtractedToGold(
  extracted: CanonicalInsight[],
  gold: GoldInsight[],
  documents: ParsedDocument[],
): { pairs: Pairing[]; missed: GoldInsight[] } {
  const usedGold = new Set<string>();
  const pairs: Pairing[] = [];

  const scored = extracted.map((ex) => {
    let best: GoldInsight | undefined;
    let bestSim = 0;
    for (const g of gold) {
      const sim = statementSimilarity(ex.statement, g.statement);
      if (sim > bestSim) {
        bestSim = sim;
        best = g;
      }
    }
    return { ex, best, bestSim };
  });

  scored.sort((a, b) => b.bestSim - a.bestSim);

  for (const row of scored) {
    if (row.best && row.bestSim >= PARTIAL && !usedGold.has(row.best.id)) {
      usedGold.add(row.best.id);
      pairs.push({
        extracted: row.ex,
        gold: row.best,
        similarity: row.bestSim,
        kind: row.bestSim >= MATCH ? "exact" : "partial",
      });
    } else {
      const grounding = groundAgainstSource(row.ex.statement, documents);
      pairs.push({
        extracted: row.ex,
        similarity: row.bestSim,
        kind: grounding >= GROUND ? "new" : "wrong",
      });
    }
  }

  const missed = gold.filter((g) => !usedGold.has(g.id));
  return { pairs, missed };
}

export function scoreMetrics(
  extracted: CanonicalInsight[],
  gold: GoldInsight[],
  documents: ParsedDocument[],
): { metrics: EvalMetrics; pairs: Pairing[]; missed: GoldInsight[] } {
  const { pairs, missed } = pairExtractedToGold(extracted, gold, documents);
  const exact = pairs.filter((p) => p.kind === "exact").length;
  const partial = pairs.filter((p) => p.kind === "partial").length;
  const wrong = pairs.filter((p) => p.kind === "wrong").length;
  const novel = pairs.filter((p) => p.kind === "new").length;
  const goldCount = gold.length;
  const extractedCount = extracted.length;
  const matched = exact + partial * 0.5;
  const precision = extractedCount === 0 ? 0 : matched / extractedCount;
  const mustFind = gold.filter((g) => g.must_find);
  const mustFound = mustFind.filter(
    (g) => !missed.some((m) => m.id === g.id),
  ).length;
  const recall = mustFind.length === 0 ? 0 : mustFound / mustFind.length;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const partial_rate = extractedCount === 0 ? 0 : partial / extractedCount;
  const wrong_rate = extractedCount === 0 ? 0 : wrong / extractedCount;
  const missed_rate = goldCount === 0 ? 0 : missed.length / goldCount;
  const new_rate = extractedCount === 0 ? 0 : novel / extractedCount;
  const composite = round4(
    0.34 * f1 +
      0.22 * (1 - wrong_rate) +
      0.2 * (1 - missed_rate) +
      0.14 * (1 - partial_rate) +
      0.1 * Math.min(new_rate, 0.25),
  );

  const metrics: EvalMetrics = {
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    partial_rate: round4(partial_rate),
    wrong_rate: round4(wrong_rate),
    missed_rate: round4(missed_rate),
    new_rate: round4(new_rate),
    composite,
    matched: exact,
    partial,
    wrong,
    missed: missed.length,
    novel,
    extracted_count: extractedCount,
    gold_count: goldCount,
  };

  return { metrics, pairs, missed };
}

export function critiqueInsights(
  extracted: CanonicalInsight[],
  gold: GoldInsight[],
  documents: ParsedDocument[],
): CritiqueFinding[] {
  const { pairs, missed } = pairExtractedToGold(extracted, gold, documents);
  const findings: CritiqueFinding[] = [];

  for (const pair of pairs) {
    if (pair.kind === "partial") {
      findings.push({
        kind: "partial",
        insight_id: pair.extracted.id,
        gold_id: pair.gold?.id,
        statement: pair.extracted.statement,
        rationale: `Only a partial match to ${pair.gold?.id ?? "gold"} (sim=${pair.similarity.toFixed(2)}). Likely double-barreled or missing an entity.`,
      });
    } else if (pair.kind === "wrong") {
      findings.push({
        kind: "wrong",
        insight_id: pair.extracted.id,
        statement: pair.extracted.statement,
        rationale:
          "Could not ground this statement in source blocks above the evidence threshold.",
      });
    } else if (pair.kind === "new") {
      findings.push({
        kind: "new",
        insight_id: pair.extracted.id,
        statement: pair.extracted.statement,
        rationale:
          "Grounded in source but absent from gold — candidate for gold-set expansion.",
      });
    }
  }

  for (const g of missed) {
    findings.push({
      kind: "missed",
      gold_id: g.id,
      statement: g.statement,
      rationale: `Gold ${g.id} (${g.classification}, ${g.source_document_id}) was not extracted.`,
    });
  }

  return findings;
}
