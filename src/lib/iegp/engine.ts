import {
  COVERAGE_DIMENSIONS,
  type CoverageDimension,
  type DimensionValue,
  type GapStatus,
  type OverallCoverage,
  type PriorityBand,
} from "./enums";
import type {
  DimensionAssessment,
  GapTacticCoverage,
  ResidualNeed,
  StrategicObjective,
  EvidenceGap,
} from "./types";
import { statementSimilarity } from "@/lib/text";

export const unlocked = (): {
  locked: false;
  actor_name: null;
  actor_function: null;
  locked_at: null;
  note: null;
} => ({
  locked: false,
  actor_name: null,
  actor_function: null,
  locked_at: null,
  note: null,
});

export const emptyDimensions = (): Record<
  CoverageDimension,
  DimensionAssessment
> => {
  const row = {} as Record<CoverageDimension, DimensionAssessment>;
  for (const dim of COVERAGE_DIMENSIONS) {
    row[dim] = { value: "unknown", rationale: "", lock: unlocked() };
  }
  return row;
};

const DIM_WEIGHT: Record<CoverageDimension, number> = {
  relevance: 1.2,
  population: 1.3,
  intervention: 1.1,
  comparator: 1.3,
  outcomes: 1.2,
  geography: 1,
  setting: 0.8,
  timing: 1.1,
  methodology: 1,
  decision_utility: 1.4,
};

function dimScore(value: DimensionValue): number {
  if (value === "yes") return 1;
  if (value === "partial") return 0.45;
  if (value === "unknown") return 0.15;
  return 0;
}

export function coverageFraction(coverage: GapTacticCoverage): number {
  let w = 0;
  let s = 0;
  for (const dim of COVERAGE_DIMENSIONS) {
    const weight = DIM_WEIGHT[dim];
    w += weight;
    s += weight * dimScore(coverage.dimensions[dim].value);
  }
  const overallBoost =
    coverage.overall === "full"
      ? 1
      : coverage.overall === "partial"
        ? 0.5
        : coverage.overall === "limited"
          ? 0.25
          : 0;
  return 0.7 * (w === 0 ? 0 : s / w) + 0.3 * overallBoost;
}

export function bestCoverageFraction(coverages: GapTacticCoverage[]): number {
  if (coverages.length === 0) return 0;
  return Math.max(...coverages.map(coverageFraction));
}

export function uncoveredDimensions(
  coverages: GapTacticCoverage[],
): CoverageDimension[] {
  if (coverages.length === 0) return [...COVERAGE_DIMENSIONS];
  const relevant = coverages.filter((c) => c.overall !== "not_relevant");
  const pool = relevant.length > 0 ? relevant : coverages;
  const out: CoverageDimension[] = [];
  for (const dim of COVERAGE_DIMENSIONS) {
    const best = Math.max(
      ...pool.map((c) => dimScore(c.dimensions[dim].value)),
    );
    if (best < 0.8) out.push(dim);
  }
  return out;
}

export function suggestGapStatus(coverages: GapTacticCoverage[]): GapStatus {
  const relevant = coverages.filter((c) => c.overall !== "not_relevant");
  if (relevant.length === 0) return "validated_open";
  const best = bestCoverageFraction(relevant);
  if (relevant.some((c) => c.overall === "full") && best >= 0.85) {
    return "validated_addressed";
  }
  if (relevant.every((c) => c.overall === "limited" || c.overall === "not_relevant") && best < 0.35) {
    return "validated_open";
  }
  if (best < 0.28) return "validated_open";
  return "validated_partial";
}

/** Engine never writes this status. Humans may lock it; evals flag auto-close. */
export function engineMaySetStatus(status: GapStatus): boolean {
  return status !== "validated_addressed";
}

export function draftResidualStatement(args: {
  gap: Pick<EvidenceGap, "name" | "statement" | "domain">;
  coverages: GapTacticCoverage[];
}): { statement: string; rationale: string; domain: EvidenceGap["domain"] } {
  const missing = uncoveredDimensions(args.coverages);
  const labels = missing.slice(0, 4).join(", ");
  const status = suggestGapStatus(args.coverages);
  let statement: string;
  if (status === "validated_addressed") {
    statement = `No residual: ${args.gap.name} is adequately addressed by existing tactics.`;
  } else if (missing.includes("comparator")) {
    statement = `Comparative outcomes versus the relevant standard of care remain insufficiently characterised for: ${args.gap.statement}`;
  } else if (missing.includes("population")) {
    statement = `The relevant population is not adequately represented for: ${args.gap.statement}`;
  } else if (args.gap.domain === "economics" || missing.includes("outcomes")) {
    statement = `Limited evidence remains on ${args.gap.domain.replaceAll("_", " ")} for: ${args.gap.statement}`;
  } else {
    statement = `Residual evidence need on ${args.gap.name}: ${args.gap.statement} Uncovered or only partial dimensions: ${labels || "overall coverage"}.`;
  }
  const rationale = `Drafted from ${args.coverages.length} tactic mapping(s). Suggested gap status ${status}. Uncovered dimensions: ${missing.join(", ") || "none"}. Original gap is preserved.`;
  return { statement, rationale, domain: args.gap.domain };
}

export function residualRequired(status: GapStatus): boolean {
  return status === "validated_partial" || status === "validated_open";
}

const STAKEHOLDER_WEIGHT: Record<string, number> = {
  hta: 1,
  market_access: 0.95,
  regulatory: 0.9,
  heor: 0.85,
  evidence_lead: 0.8,
  rwe: 0.7,
  medical_affairs: 0.65,
  clinical_development: 0.65,
  commercial: 0.5,
  regional: 0.55,
  epidemiology: 0.5,
  patient_engagement: 0.45,
};

export function suggestPriority(args: {
  residual: Pick<ResidualNeed, "statement">;
  objective: Pick<
    StrategicObjective,
    "strategic_importance" | "decision_date" | "key_decision"
  >;
  coverages: GapTacticCoverage[];
  stakeholder?: string;
  today?: Date;
}): { score: number; band: PriorityBand; reasons: string[] } {
  const today = args.today ?? new Date("2026-09-17T00:00:00Z");
  const importance = Math.min(5, Math.max(1, args.objective.strategic_importance)) / 5;
  const decision = new Date(args.objective.decision_date);
  const days = Math.max(
    0,
    (decision.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
  );
  const timeUrgency = days <= 90 ? 1 : days <= 180 ? 0.8 : days <= 365 ? 0.55 : 0.35;
  const uncovered = uncoveredDimensions(args.coverages);
  const severity = Math.min(
    1,
    0.35 + (1 - bestCoverageFraction(args.coverages)) * 0.65 + (uncovered.includes("comparator") ? 0.08 : 0),
  );
  const stakeholder =
    STAKEHOLDER_WEIGHT[args.stakeholder ?? "heor"] ?? 0.6;
  const raw = 100 * importance * (0.35 + 0.65 * timeUrgency) * severity * (0.5 + 0.5 * stakeholder);
  const score = Math.round(Math.min(100, Math.max(1, raw)));
  const band: PriorityBand =
    score >= 75 ? "critical" : score >= 55 ? "high" : score >= 35 ? "medium" : "low";
  const reasons = [
    `Strategic importance ${args.objective.strategic_importance}/5`,
    `Decision "${args.objective.key_decision}" on ${args.objective.decision_date} (urgency ${timeUrgency})`,
    `Residual severity ${severity.toFixed(2)} from coverage (feasibility lives on the tactic)`,
    `Stakeholder weight ${stakeholder.toFixed(2)}`,
  ];
  return { score, band, reasons };
}

export type NeedPairKind = "exact" | "partial" | "new" | "wrong" | "missed";

export function pairNeeds(
  extracted: { id: string; statement: string; source_id: string }[],
  gold: { id: string; statement: string; source_id: string; must_find: boolean }[],
): {
  kind: NeedPairKind;
  extract_id?: string;
  gold_id?: string;
  similarity: number;
}[] {
  const usedGold = new Set<string>();
  const usedExtract = new Set<string>();
  const rows: {
    kind: NeedPairKind;
    extract_id?: string;
    gold_id?: string;
    similarity: number;
  }[] = [];
  const ranked: { e: (typeof extracted)[0]; g: (typeof gold)[0]; sim: number }[] =
    [];
  for (const e of extracted) {
    for (const g of gold) {
      if (e.source_id !== g.source_id) continue;
      ranked.push({ e, g, sim: statementSimilarity(e.statement, g.statement) });
    }
  }
  ranked.sort((a, b) => b.sim - a.sim);
  for (const row of ranked) {
    if (usedExtract.has(row.e.id) || usedGold.has(row.g.id)) continue;
    if (row.sim >= 0.58) {
      rows.push({
        kind: "exact",
        extract_id: row.e.id,
        gold_id: row.g.id,
        similarity: row.sim,
      });
      usedExtract.add(row.e.id);
      usedGold.add(row.g.id);
    } else if (row.sim >= 0.32) {
      rows.push({
        kind: "partial",
        extract_id: row.e.id,
        gold_id: row.g.id,
        similarity: row.sim,
      });
      usedExtract.add(row.e.id);
      usedGold.add(row.g.id);
    }
  }
  for (const e of extracted) {
    if (usedExtract.has(e.id)) continue;
    const grounded = gold.some(
      (g) => g.source_id === e.source_id && statementSimilarity(e.statement, g.statement) >= 0.28,
    );
    rows.push({
      kind: grounded ? "new" : "wrong",
      extract_id: e.id,
      similarity: 0,
    });
  }
  for (const g of gold) {
    if (usedGold.has(g.id)) continue;
    rows.push({ kind: "missed", gold_id: g.id, similarity: 0 });
  }
  return rows;
}

export function needEvalMetrics(
  pairs: ReturnType<typeof pairNeeds>,
  gold: { id: string; must_find: boolean }[],
  extractedCount: number,
) {
  const exact = pairs.filter((p) => p.kind === "exact").length;
  const partial = pairs.filter((p) => p.kind === "partial").length;
  const wrong = pairs.filter((p) => p.kind === "wrong").length;
  const missed = pairs.filter((p) => p.kind === "missed").length;
  const must = gold.filter((g) => g.must_find);
  const mustPaired = must.filter((g) =>
    pairs.some(
      (p) => p.gold_id === g.id && (p.kind === "exact" || p.kind === "partial"),
    ),
  ).length;
  const precision =
    extractedCount === 0 ? 0 : (exact + 0.5 * partial) / extractedCount;
  const recall = must.length === 0 ? 1 : mustPaired / must.length;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const wrongRate = extractedCount === 0 ? 0 : wrong / extractedCount;
  const composite =
    0.4 * f1 + 0.3 * (1 - wrongRate) + 0.3 * recall;
  return { exact, partial, wrong, missed, precision, recall, f1, wrongRate, composite };
}

export function coverageEval(
  live: { gap_id: string; tactic_id: string; overall: OverallCoverage }[],
  gold: { gap_id: string; tactic_id: string; overall: OverallCoverage }[],
) {
  let exact = 0;
  let missed = 0;
  let wrong = 0;
  for (const g of gold) {
    const hit = live.find(
      (l) => l.gap_id === g.gap_id && l.tactic_id === g.tactic_id,
    );
    if (!hit) missed += 1;
    else if (hit.overall === g.overall) exact += 1;
    else wrong += 1;
  }
  return {
    exact,
    missed,
    wrong,
    recall: gold.length === 0 ? 1 : exact / gold.length,
  };
}

const NEED_CUES =
  /\b(need to (know|understand|characterise|characterize|quantify)|insufficient|limited evidence|not (adequately )?characterised|not (adequately )?characterized|evidence gap|unknown whether|no (comparative|rwe|real-world)|lack of|unresolved|open question)\b/i;

export function extractCandidateNeeds(
  blocks: { id: string; source_id: string; text: string; heading: string }[],
): { id: string; statement: string; source_id: string; source_quote: string }[] {
  const out: {
    id: string;
    statement: string;
    source_id: string;
    source_quote: string;
  }[] = [];
  let n = 0;
  for (const block of blocks) {
    const sentences = block.text
      .split(/(?<=[.?!])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 24);
    for (const sentence of sentences) {
      if (!NEED_CUES.test(sentence) && !NEED_CUES.test(block.heading)) continue;
      n += 1;
      out.push({
        id: `EXT-${String(n).padStart(3, "0")}`,
        statement: sentence.replace(/\s+/g, " "),
        source_id: block.source_id,
        source_quote: sentence.slice(0, 280),
      });
    }
  }
  return out;
}
