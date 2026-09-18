import {
  COVERAGE_DIMENSIONS,
  type CoverageDimension,
  type DimensionValue,
  type EvidenceDomain,
  type GapStatus,
  type OverallCoverage,
  type PriorityBand,
  type TacticStatus,
  type TacticType,
} from "./enums";
import type {
  DimensionAssessment,
  GapTacticCoverage,
  ResidualNeed,
  StrategicObjective,
  EvidenceGap,
  IegpState,
  Tactic,
} from "./types";
import { statementSimilarity } from "@/lib/text";
import {
  MAPPING_SCORE_FLOOR,
  MAPPING_SUGGESTION_CAP,
  isDisseminationTactic,
  scoreGapTacticMapping,
  type MappingScoreExtras,
  type MappingSuggestion,
} from "./mapping";

export {
  MAPPING_SCORE_FLOOR,
  MAPPING_SUGGESTION_CAP,
  scoreGapTacticMapping,
  isDisseminationTactic,
  type MappingScore,
  type MappingScoreExtras,
  type MappingSuggestion,
} from "./mapping";

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
    statement = "No residual: existing tactics adequately address this gap.";
  } else if (missing.includes("comparator")) {
    statement =
      "Comparative outcomes versus the relevant standard of care remain insufficiently characterised.";
  } else if (missing.includes("population")) {
    statement = "The relevant population is not adequately represented.";
  } else if (args.gap.domain === "economics" || missing.includes("outcomes")) {
    statement = `Limited evidence remains on ${args.gap.domain.replaceAll("_", " ")}.`;
  } else {
    statement = `Uncovered or only partial dimensions remain: ${labels || "overall coverage"}.`;
  }
  const rationale = `Drafted from ${args.coverages.length} tactic mapping(s). Suggested gap status ${status}. Uncovered dimensions: ${missing.join(", ") || "none"}. Original gap is preserved.`;
  return { statement, rationale, domain: args.gap.domain };
}

/** Leftover evidence need exists only after a tactic is assigned and coverage is understood as partial/limited. */
export function residualDraftEligible(args: {
  gap: Pick<EvidenceGap, "status">;
  coverages: GapTacticCoverage[];
}): boolean {
  if (args.gap.status === "validated_addressed" || args.gap.status === "excluded") return false;
  if (args.coverages.length === 0) return false;
  return args.coverages.some(
    (c) => c.overall_lock.locked && (c.overall === "partial" || c.overall === "limited"),
  );
}

/**
 * Leftover-as-new-gap: human-locked overall of partial/limited.
 * Unlocked assignment defaults (overall "limited") and inferred drafts do not enqueue.
 */
export function residualGapEligible(args: {
  gap: Pick<EvidenceGap, "status">;
  coverages: GapTacticCoverage[];
  hasChild: boolean;
  suppressed: boolean;
}): boolean {
  if (args.suppressed || args.hasChild) return false;
  if (args.gap.status === "excluded" || args.gap.status === "validated_addressed") return false;
  return residualDraftEligible(args);
}

function tacticEligibleForPressureTest(tactic: Pick<Tactic, "review_status" | "status">): boolean {
  return tactic.review_status !== "rejected" && tactic.status !== "cancelled";
}

/** Deterministic mapping/coverage vs extracted tactics — not a human lock. */
export function inferPressureTestCoverages(
  gap: Pick<EvidenceGap, "id" | "name" | "statement" | "domain">,
  tactics: Tactic[],
  extras: { needs?: MappingScoreExtras["needs"] } = {},
): GapTacticCoverage[] {
  const hits: GapTacticCoverage[] = [];
  for (const tactic of tactics) {
    if (!tacticEligibleForPressureTest(tactic)) continue;
    if (isDisseminationTactic(tactic) && gap.domain !== "implementation") continue;
    const scored = scoreGapTacticMapping(gap, tactic, extras);
    if (scored.score < MAPPING_SCORE_FLOOR) continue;
    const dimensions = emptyDimensions();
    const gapHay = `${gap.name} ${gap.statement}`.toLowerCase();
    const tacticHay =
      `${tactic.name} ${tactic.evidence_question} ${tactic.description} ${tactic.population} ${tactic.comparator} ${tactic.outcomes}`.toLowerCase();
    dimensions.relevance = {
      value: "partial",
      rationale: scored.reasons[0] ?? "Related extracted tactic.",
      lock: unlocked(),
    };
    const popCue = /elderly|aged|65|frail|cns|brain|community/;
    dimensions.population = {
      value: popCue.test(gapHay) && popCue.test(tacticHay) ? "partial" : "unknown",
      rationale: "",
      lock: unlocked(),
    };
    const wantsComparator = /comparat|versus|vs\.|standard of care|\bsoc\b/.test(gapHay);
    const singleArm = /no comparative|single-arm|no comparator|not a powered comparative/.test(
      tacticHay,
    );
    if (wantsComparator && (singleArm || !/comparat|versus|standard of care|\bsoc\b/.test(tacticHay))) {
      dimensions.comparator = { value: "no", rationale: "Extracted tactic has no SoC arm.", lock: unlocked() };
    } else if (wantsComparator) {
      dimensions.comparator = { value: "partial", rationale: "", lock: unlocked() };
    }
    dimensions.decision_utility = {
      value: "partial",
      rationale: "Pressure-test: parent is already partial, not closed.",
      lock: unlocked(),
    };
    hits.push({
      id: `pt-${gap.id}-${tactic.id}`,
      gap_id: gap.id,
      tactic_id: tactic.id,
      dimensions,
      overall: "partial",
      overall_rationale: scored.reasons.join(" "),
      overall_lock: unlocked(),
      stale: false,
    });
  }
  return hits;
}

export type ResidualGapSuggestion = {
  parent_gap_id: string;
  parent_name: string;
  parent_statement: string;
  statement: string;
  reasons: string[];
  domain: EvidenceGap["domain"];
};

/** Draft leftover text that is not a copy of the parent gap sentence. */
export function draftResidualGapSuggestion(args: {
  gap: Pick<EvidenceGap, "id" | "name" | "statement" | "domain">;
  coverages: GapTacticCoverage[];
}): ResidualGapSuggestion {
  const draft = draftResidualStatement({ gap: args.gap, coverages: args.coverages });
  let statement = draft.statement;
  if (
    similarRecord(statement, args.gap.statement, 0.62) ||
    similarRecord(statement, args.gap.name, 0.62)
  ) {
    const missing = uncoveredDimensions(args.coverages);
    statement = `Uncovered or only partial dimensions remain: ${missing.slice(0, 4).join(", ") || "overall coverage"}.`;
  }
  const locked = args.coverages.filter((c) => c.overall_lock.locked);
  const pool = locked.length > 0 ? locked : args.coverages;
  const overalls = [...new Set(pool.map((c) => c.overall))];
  const missing = uncoveredDimensions(args.coverages);
  const status = suggestGapStatus(args.coverages);
  return {
    parent_gap_id: args.gap.id,
    parent_name: args.gap.name,
    parent_statement: args.gap.statement,
    statement,
    reasons: [
      `Pressure-test coverage overall ${overalls.join(", ")} (${locked.length ? "human-locked" : "engine draft"}).`,
      `Suggested gap status ${status}. Parent stays; leftover is a new gap.`,
      `Uncovered or partial dimensions: ${missing.join(", ") || "none"}.`,
    ],
    domain: draft.domain,
  };
}

function needsForGap(state: IegpState, gapId: string) {
  const ids = state.need_gap_links.filter((link) => link.gap_id === gapId).map((link) => link.need_id);
  return state.needs.filter((need) => ids.includes(need.id));
}

function coveragesForResidualDraft(state: IegpState, gap: EvidenceGap): GapTacticCoverage[] {
  return state.coverages.filter(
    (c) =>
      c.gap_id === gap.id &&
      c.overall_lock.locked &&
      (c.overall === "partial" || c.overall === "limited"),
  );
}

/** Ranked leftover-as-new-gap drafts for Mappings. Engine suggests; it does not create the child. */
export function suggestResidualGaps(state: IegpState): ResidualGapSuggestion[] {
  const suppressed = new Set(
    state.residual_gap_suggestions
      .filter((row) => row.status === "rejected" || row.status === "accepted")
      .map((row) => row.parent_gap_id),
  );
  const childByParent = new Set(
    state.gaps.map((gap) => gap.parent_gap_id).filter((id): id is string => Boolean(id)),
  );
  const edited = new Map(
    state.residual_gap_suggestions
      .filter((row) => row.status === "candidate")
      .map((row) => [row.parent_gap_id, row.statement] as const),
  );
  const out: ResidualGapSuggestion[] = [];
  for (const gap of state.gaps) {
    if (
      !residualGapEligible({
        gap,
        coverages: coveragesForResidualDraft(state, gap),
        hasChild: childByParent.has(gap.id),
        suppressed: suppressed.has(gap.id),
      })
    ) {
      continue;
    }
    const coverages = coveragesForResidualDraft(state, gap);
    if (coverages.length === 0) continue;
    const draft = draftResidualGapSuggestion({ gap, coverages });
    const statement = edited.get(gap.id) ?? draft.statement;
    out.push({ ...draft, statement });
  }
  return out;
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

const TACTIC_CUES =
  /\b(phase\s*(iii|3)|vel-\d+|prospective \w+ registry|registry will|chart review|study [a-c]\b|publication|manuscript|congress abstract|budget-impact|cost-effectiveness|network meta|indirect treatment|patient survey|claims study|long-term follow-up)\b/i;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 24);
}

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
    for (const sentence of sentencesOf(block.text)) {
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

export function guessDomain(text: string): EvidenceDomain {
  const t = text.toLowerCase();
  if (/\b(comparat|versus|vs\.? |standard of care|soc)\b/.test(t)) {
    return "comparative_effectiveness";
  }
  if (/\b(ira|budget impact|net-price)\b/.test(t)) return "budget_impact";
  if (/\b(cost|economic burden|repeat procedure)\b/.test(t)) return "economics";
  if (/\b(cns|intracranial|brain metast)\b/.test(t)) return "efficacy";
  if (/\bsequenc/.test(t)) return "treatment_sequencing";
  if (/\b(hcru|hospitalisation|hospitalization|emergency-department|ed use)\b/.test(t)) {
    return "hcru";
  }
  if (/\bcaregiver/.test(t)) return "caregiver_burden";
  if (/\b(qol|pro|eortc)\b/.test(t)) return "qol_pro";
  if (/\b(persist|discontinu)/.test(t)) return "adherence";
  if (/\b(ild|safety|qt)\b/.test(t)) return "safety";
  if (/\b(overall survival|\bos\b)\b/.test(t)) return "long_term_outcomes";
  if (/\b(65|elderly|frail|subpopulation)/.test(t)) return "subpopulations";
  return "unmet_need";
}

export function guessTacticType(text: string): TacticType {
  const t = text.toLowerCase();
  if (/\b(publication|manuscript)/.test(t)) return "publication";
  if (/\bcongress abstract/.test(t)) return "congress_abstract";
  if (/\bphase\s*(iii|3)|vel-\d+/.test(t)) return "phase3_trial";
  if (/\bregistry/.test(t)) return "registry";
  if (/\bchart review/.test(t)) return "chart_review";
  if (/\bbudget-impact|\bbim\b/.test(t)) return "budget_impact_model";
  if (/\bcost-effectiveness|\bcea\b/.test(t)) return "cea";
  if (/\bnetwork meta|\bnma\b/.test(t)) return "nma";
  if (/\bindirect treatment|\bitc\b/.test(t)) return "itc";
  if (/\bsurvey/.test(t)) return "patient_survey";
  if (/\bclaims/.test(t)) return "rwe_study";
  if (/\bslr|systematic literature/.test(t)) return "slr";
  if (/\blong-term follow/.test(t)) return "long_term_followup";
  return "rwe_study";
}

const SOURCE_TITLE_CUES =
  /\b(interview|excerpt|dossier|strategy|advisory|stakeholder|clinical development plan|literature review)\b/i;

/** Short in-document labels such as "Elderly" or "CNS", not the source title. */
export function isSectionHeading(line: string, sourceTitle?: string): boolean {
  const t = line.trim().replace(/^#+\s*/, "");
  if (t.length < 2 || t.length > 42) return false;
  if (/[.?!]$/.test(t) || /[—–]/.test(t)) return false;
  if (sourceTitle && t.toLowerCase() === sourceTitle.trim().toLowerCase()) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  if (SOURCE_TITLE_CUES.test(t) && words.length >= 3) return false;
  if (words.length === 1) return /[A-Za-z]/.test(t);
  return words.every(
    (w) => /^[A-Z0-9]/.test(w) || /^(and|of|vs|versus|the|in|for)$/i.test(w),
  );
}

export function splitSourceIntoBlocks(
  text: string,
  sourceTitle?: string,
): { heading: string; text: string }[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blocks: { heading: string; text: string }[] = [];
  let heading = "";
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (!body) {
      heading = "";
      buf = [];
      return;
    }
    blocks.push({ heading: heading || "Note", text: body });
    heading = "";
    buf = [];
  };

  for (const line of lines) {
    if (isSectionHeading(line, sourceTitle)) {
      flush();
      heading = line.trim().replace(/^#+\s*/, "");
      continue;
    }
    buf.push(line);
  }
  flush();
  if (blocks.length === 0) {
    return [{ heading: "Note", text: text.trim() }];
  }
  return blocks;
}

const NAME_NEED_PREFIX =
  /^(?:(?:we|kols|there\s+is)\s+)?(?:need to (?:know|understand|characterise|characterize|quantify)\s+)/i;

const NAME_TRAILING_FUNCTION =
  /^(the|a|an|of|vs\.?|versus|and|or|but|in|on|for|with|after|before|to|from|by|as|at|into|than|associated)$/i;

const NAME_FINITE_VERB =
  /\b(is|are|was|were|isn't|aren't|has|have|had|does|do|did|will|would|can|could|should|may|might|must|remains?|characterises|characterizes|includes?|reports?|measures?|addresses?|collects?|sits?|blocks?|reflects?|exists?)\b/i;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Keep a readable sentence: ~12–16 words, never a hanging preposition. */
function clipToReadableSentence(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const cutAt = (n: number) => words.slice(0, n).join(" ").replace(/[,;:]+$/, "");
  if (words.length <= 16) {
    let n = words.length;
    while (n > 8 && NAME_TRAILING_FUNCTION.test(words[n - 1]!)) n -= 1;
    return cutAt(n);
  }
  for (let i = 16; i >= 12; i -= 1) {
    if (/[,;]$/.test(words[i - 1]!)) return cutAt(i);
  }
  let n = 16;
  while (n > 8 && NAME_TRAILING_FUNCTION.test(words[n - 1]!)) n -= 1;
  while (n < words.length && n < 18 && NAME_TRAILING_FUNCTION.test(words[n - 1]!)) n += 1;
  return cutAt(n);
}

function remainderIsSentence(text: string): boolean {
  if (wordCount(text) < 6) return false;
  if (/^(on|in|of|for|that|this|whether|the question)\b/i.test(text)) return false;
  return true;
}

/**
 * Card title for a gap or extracted tactic. Derived from the evidence statement only —
 * never a section heading prefix such as "Burden:" or "Elderly:".
 */
export function gapNameFromStatement(statement: string, heading?: string): string {
  void heading;
  const cleaned = statement.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Unnamed gap.";

  let body = cleaned.replace(/[.?!]+$/g, "").trim();
  const firstBreak = body.search(/[.?!]\s/);
  if (firstBreak > 0) body = body.slice(0, firstBreak).trim();

  const stripped = body.replace(NAME_NEED_PREFIX, "").trim();
  const usedStrip = Boolean(stripped && stripped !== body && remainderIsSentence(stripped));
  if (usedStrip) body = stripped;

  if (
    usedStrip &&
    !NAME_FINITE_VERB.test(body) &&
    /^(the|a|an)\s/i.test(body) &&
    wordCount(body) <= 12
  ) {
    body = `${body} is not adequately characterised`;
  }

  body = clipToReadableSentence(body);
  if (!body) return "Unnamed gap.";
  const named = body.charAt(0).toUpperCase() + body.slice(1);
  return /[.?!]$/.test(named) ? named : `${named}.`;
}

export type ExtractedGap = {
  id: string;
  name: string;
  statement: string;
  domain: EvidenceDomain;
  source_id: string;
  source_quote: string;
};

export function extractCandidateGaps(
  blocks: { id: string; source_id: string; text: string; heading: string }[],
): ExtractedGap[] {
  const out: ExtractedGap[] = [];
  let n = 0;
  for (const block of blocks) {
    for (const sentence of sentencesOf(block.text)) {
      if (!NEED_CUES.test(sentence) && !NEED_CUES.test(block.heading)) continue;
      n += 1;
      const statement = sentence.replace(/\s+/g, " ");
      out.push({
        id: `XGAP-${String(n).padStart(3, "0")}`,
        name: gapNameFromStatement(statement),
        statement,
        domain: guessDomain(`${block.heading} ${statement}`),
        source_id: block.source_id,
        source_quote: sentence.slice(0, 280),
      });
    }
  }
  return out;
}

export type ExtractedTactic = {
  id: string;
  name: string;
  type: TacticType;
  evidence_question: string;
  source_id: string;
  source_quote: string;
};

export function extractCandidateTactics(
  blocks: { id: string; source_id: string; text: string; heading: string }[],
): ExtractedTactic[] {
  const out: ExtractedTactic[] = [];
  let n = 0;
  for (const block of blocks) {
    for (const sentence of sentencesOf(block.text)) {
      if (!TACTIC_CUES.test(sentence) && !TACTIC_CUES.test(block.heading)) continue;
      n += 1;
      const statement = sentence.replace(/\s+/g, " ");
      out.push({
        id: `XTAC-${String(n).padStart(3, "0")}`,
        name: gapNameFromStatement(statement),
        type: guessTacticType(statement),
        evidence_question: statement,
        source_id: block.source_id,
        source_quote: sentence.slice(0, 280),
      });
    }
  }
  return out;
}

export function similarRecord(a: string, b: string, floor = 0.5): boolean {
  return statementSimilarity(a, b) >= floor;
}

const ACCEPTED_GAP_FOR_MAPPING: GapStatus[] = ["validated_open", "validated_partial"];

export function gapEligibleForMapping(status: GapStatus): boolean {
  return ACCEPTED_GAP_FOR_MAPPING.includes(status);
}

export function tacticEligibleForMapping(tactic: Pick<Tactic, "review_status" | "status">): boolean {
  return tactic.review_status === "accepted" && tactic.status !== "cancelled";
}

/** Ranked gap–tactic pairs. Engine suggests; it does not write coverage. */
export function suggestMappings(state: IegpState): MappingSuggestion[] {
  const rejected = new Set(
    state.mapping_suggestions
      .filter((row) => row.status === "rejected")
      .map((row) => `${row.gap_id}::${row.tactic_id}`),
  );
  const covered = new Set(
    state.coverages.map((row) => `${row.gap_id}::${row.tactic_id}`),
  );
  const needsByGap = new Map<string, IegpState["needs"]>();
  for (const link of state.need_gap_links) {
    const need = state.needs.find((row) => row.id === link.need_id);
    if (!need) continue;
    const list = needsByGap.get(link.gap_id) ?? [];
    list.push(need);
    needsByGap.set(link.gap_id, list);
  }
  const residualByGap = new Map(state.residuals.map((row) => [row.gap_id, row.statement]));
  const gaps = state.gaps.filter((gap) => gapEligibleForMapping(gap.status));
  const tactics = state.tactics.filter((tactic) => tacticEligibleForMapping(tactic));
  const out: MappingSuggestion[] = [];
  for (const gap of gaps) {
    for (const tactic of tactics) {
      const key = `${gap.id}::${tactic.id}`;
      if (rejected.has(key) || covered.has(key)) continue;
      const scored = scoreGapTacticMapping(gap, tactic, {
        needs: needsByGap.get(gap.id),
        residual_statement: residualByGap.get(gap.id),
        rejected: false,
        covered: false,
      });
      if (scored.score < MAPPING_SCORE_FLOOR) continue;
      out.push({
        gap_id: gap.id,
        gap_name: gap.name,
        gap_statement: gap.statement,
        tactic_id: tactic.id,
        tactic_name: tactic.name,
        reasons: scored.reasons,
        score: scored.score,
      });
    }
  }
  out.sort(
    (a, b) => b.score - a.score || a.gap_name.localeCompare(b.gap_name) || a.tactic_name.localeCompare(b.tactic_name),
  );
  return out.slice(0, MAPPING_SUGGESTION_CAP);
}

export type PlanColumn = "high" | "medium" | "low";

export function planColumn(band: PriorityBand): PlanColumn {
  if (band === "critical" || band === "high") return "high";
  if (band === "medium") return "medium";
  return "low";
}

export type PlanTactic = {
  id: string;
  name: string;
  status: TacticStatus;
  overall: OverallCoverage | null;
  stale: boolean;
};

export type PlanGapCard = {
  gap_id: string;
  gap_name: string;
  statement: string;
  residual: string;
  gap_status: GapStatus;
  residual_id: string | null;
  band: PriorityBand | null;
  score: number;
  tactics: PlanTactic[];
  parent_gap_id: string | null;
};

export type ReviewGapCard = {
  gap_id: string;
  gap_name: string;
  statement: string;
  tactics: PlanTactic[];
};

export type OpenGapCard = {
  gap_id: string;
  gap_name: string;
  statement: string;
  gap_status: GapStatus;
  tactics: PlanTactic[];
  parent_gap_id: string | null;
};

export type ReviewTacticCard = {
  tactic_id: string;
  name: string;
  type: Tactic["type"];
  evidence_question: string;
  description: string;
};

export type UnprioritizedGapCard = {
  gap_id: string;
  gap_name: string;
  statement: string;
  residual: string;
  gap_status: GapStatus;
  residual_id: string;
  tactics: PlanTactic[];
};

const STATUS_ORDER: Record<TacticStatus, number> = {
  ongoing: 0,
  planned: 1,
  proposed: 2,
  completed: 3,
  cancelled: 4,
};

function asPlanTactic(tactic: Tactic, overall: OverallCoverage | null, stale: boolean): PlanTactic {
  return {
    id: tactic.id,
    name: tactic.name,
    status: tactic.status,
    overall,
    stale,
  };
}

export function mappedTactics(state: IegpState, gapId: string, residualId?: string | null): PlanTactic[] {
  const mapped: PlanTactic[] = [];
  for (const coverage of state.coverages.filter((c) => c.gap_id === gapId)) {
    const tactic = state.tactics.find((t) => t.id === coverage.tactic_id);
    if (!tactic) continue;
    mapped.push(asPlanTactic(tactic, coverage.overall, coverage.stale));
  }
  if (residualId) {
    for (const item of state.roadmap.filter((row) => row.residual_ids.includes(residualId))) {
      const tactic = state.tactics.find((t) => t.id === item.tactic_id);
      if (!tactic || mapped.some((row) => row.id === tactic.id)) continue;
      mapped.push(asPlanTactic(tactic, null, false));
    }
  }
  return mapped.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  );
}

export function buildPlanBoard(state: IegpState): Record<PlanColumn, PlanGapCard[]> {
  const cards: PlanGapCard[] = [];
  for (const residual of state.residuals) {
    const gap = state.gaps.find((g) => g.id === residual.gap_id);
    if (!gap || gap.status === "excluded" || gap.status === "validated_addressed") continue;
    const priority = state.priorities.find((p) => p.residual_id === residual.id);
    if (!priority?.lock.locked) continue;
    cards.push({
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      residual: residual.statement,
      gap_status: gap.status,
      residual_id: residual.id,
      band: priority.band,
      score: priority.suggested_score,
      tactics: mappedTactics(state, gap.id, residual.id),
      parent_gap_id: gap.parent_gap_id,
    });
  }
  cards.sort((a, b) => b.score - a.score);
  return {
    high: cards.filter((c) => c.band && planColumn(c.band) === "high"),
    medium: cards.filter((c) => c.band && planColumn(c.band) === "medium"),
    low: cards.filter((c) => c.band && planColumn(c.band) === "low"),
  };
}

export type TacticLibraryItem = {
  id: string;
  name: string;
  type: Tactic["type"];
  gaps: { id: string; name: string }[];
};

export function buildTacticLibrary(state: IegpState): TacticLibraryItem[] {
  return state.tactics
    .filter((t) => t.status !== "cancelled" && t.review_status === "accepted")
    .map((t) => {
      const gapIds = [
        ...new Set(state.coverages.filter((c) => c.tactic_id === t.id).map((c) => c.gap_id)),
      ];
      const gaps = gapIds
        .map((id) => state.gaps.find((row) => row.id === id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .filter((row) => row.status !== "excluded")
        .map((row) => ({ id: row.id, name: row.name }));
      return { id: t.id, name: t.name, type: t.type, gaps };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildPlanWorkspace(state: IegpState): {
  review: ReviewGapCard[];
  reviewTactics: ReviewTacticCard[];
  reviewResiduals: ResidualGapSuggestion[];
  openGaps: OpenGapCard[];
  unprioritized: UnprioritizedGapCard[];
  board: Record<PlanColumn, PlanGapCard[]>;
  addressed: PlanGapCard[];
  availableTactics: TacticLibraryItem[];
  mappingSuggestions: MappingSuggestion[];
  residualGapSuggestions: ResidualGapSuggestion[];
} {
  const review: ReviewGapCard[] = [];
  for (const gap of state.gaps.filter((g) => g.status === "candidate")) {
    review.push({
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      tactics: mappedTactics(state, gap.id),
    });
  }

  const openGaps: OpenGapCard[] = [];
  for (const gap of state.gaps.filter(
    (g) => g.status === "validated_open" || g.status === "validated_partial",
  )) {
    const residual = state.residuals.find((r) => r.gap_id === gap.id);
    openGaps.push({
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      gap_status: gap.status,
      tactics: mappedTactics(state, gap.id, residual?.id),
      parent_gap_id: gap.parent_gap_id,
    });
  }

  const reviewTactics: ReviewTacticCard[] = state.tactics
    .filter((t) => t.review_status === "candidate")
    .map((t) => ({
      tactic_id: t.id,
      name: t.name,
      type: t.type,
      evidence_question: t.evidence_question,
      description: t.description,
    }));

  const prioritizedResidual = new Set(
    state.priorities.filter((p) => p.lock.locked).map((p) => p.residual_id),
  );
  const unprioritized: UnprioritizedGapCard[] = [];
  for (const residual of state.residuals) {
    if (prioritizedResidual.has(residual.id)) continue;
    if (residual.review_status === "candidate" || residual.review_status === "rejected") continue;
    if (residual.created_gap_id) continue;
    const gap = state.gaps.find((g) => g.id === residual.gap_id);
    if (!gap) continue;
    if (gap.status !== "validated_open" && gap.status !== "validated_partial") continue;
    const coverages = state.coverages.filter((c) => c.gap_id === gap.id);
    if (!residualDraftEligible({ gap, coverages })) continue;
    unprioritized.push({
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      residual: residual.statement,
      gap_status: gap.status,
      residual_id: residual.id,
      tactics: mappedTactics(state, gap.id, residual.id),
    });
  }

  const addressed: PlanGapCard[] = [];
  for (const gap of state.gaps.filter((g) => g.status === "validated_addressed")) {
    const residual = state.residuals.find((r) => r.gap_id === gap.id);
    addressed.push({
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      residual: residual?.statement ?? "No residual — this gap is addressed.",
      gap_status: gap.status,
      residual_id: residual?.id ?? null,
      band: null,
      score: 0,
      tactics: mappedTactics(state, gap.id, residual?.id),
      parent_gap_id: gap.parent_gap_id,
    });
  }

  const reviewResiduals = suggestResidualGaps(state);
  return {
    review,
    reviewTactics,
    reviewResiduals,
    openGaps,
    unprioritized,
    board: buildPlanBoard(state),
    addressed,
    availableTactics: buildTacticLibrary(state),
    mappingSuggestions: suggestMappings(state),
    residualGapSuggestions: reviewResiduals,
  };
}

export const PLAN_PLACES = ["upload", "review", "mappings", "library", "plan"] as const;
export type PlanPlace = (typeof PLAN_PLACES)[number];

export function isPlanPlace(value: string | undefined): value is PlanPlace {
  return Boolean(value && (PLAN_PLACES as readonly string[]).includes(value));
}

export function planGates(state: IegpState): {
  hasSources: boolean;
  hasAccepts: boolean;
  reviewUnlocked: boolean;
  mappingsUnlocked: boolean;
  libraryUnlocked: boolean;
  planUnlocked: boolean;
} {
  const hasSources = state.sources.length > 0;
  const hasAccepts =
    state.gaps.some(
      (g) =>
        g.status === "validated_open" ||
        g.status === "validated_partial" ||
        g.status === "validated_addressed",
    ) || state.tactics.some((t) => t.review_status === "accepted");
  const reviewUnlocked = hasSources;
  return {
    hasSources,
    hasAccepts,
    reviewUnlocked,
    mappingsUnlocked: reviewUnlocked,
    libraryUnlocked: reviewUnlocked,
    planUnlocked: state.asset.wizard_complete || (hasSources && hasAccepts),
  };
}

export function defaultPlanPlace(
  state: IegpState,
  workspace: Pick<
    ReturnType<typeof buildPlanWorkspace>,
    "review" | "reviewTactics" | "reviewResiduals"
  >,
): PlanPlace {
  if (state.asset.wizard_complete) return "plan";
  if (state.sources.length === 0) return "upload";
  if (
    workspace.review.length > 0 ||
    workspace.reviewTactics.length > 0 ||
    workspace.reviewResiduals.length > 0
  ) {
    return "review";
  }
  return "review";
}

export function planNavCounts(workspace: ReturnType<typeof buildPlanWorkspace>): {
  review: number;
  mappings: number;
} {
  return {
    review:
      workspace.review.length + workspace.reviewTactics.length + workspace.reviewResiduals.length,
    mappings: workspace.mappingSuggestions.length,
  };
}
