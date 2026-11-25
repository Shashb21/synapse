import { sql } from "drizzle-orm";
import { lockRelationships } from "@/lib/iegp/relationship-change";
import { withWorkspaceTransaction } from "@/lib/iegp/db";
import { tacticEditVersion } from "@/lib/iegp/tactic-edit-version";
import { judgementReferenceSchema, suppliedJudgementRecordSchema, suppliedJudgementRecords, inspectSuppliedJudgementReferences } from "@/lib/iegp/judgement-references";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { db, ensurePlatformSchema } from "@/modules/kernel/db";
import { newId, nowIso } from "@/modules/kernel/ids";
import { registerModule } from "@/modules/kernel/registry";
import { PROPOSER_CRITIC_EXCHANGES, runAgenticCycle, type Critique } from "@/modules/kernel/agentic";
import { completeAll, isTestStub, requireLlm } from "@/modules/kernel/llm";
import { modelRows } from "@/modules/kernel/model-rows";
import { NoRouteError } from "@/modules/llm/provider";
import type { ModuleContext, SynapseModule } from "@/modules/kernel/contracts";
import { assignTacticToGap, humanAcceptedExpansionScope, humanRejectedPairs, loadState, lockAssessmentOwners } from "@/lib/iegp/store";
import { gapEligibleForMapping, tacticEligibleForMapping, emptyDimensions, unlocked } from "@/lib/iegp/engine";
import { ASSESSED_COVERAGE, COVERAGE_DIMENSIONS, DIMENSION_VALUES, OVERALL_COVERAGE } from "@/lib/iegp/enums";
import { MAPPING_SCORE_FLOOR, scoreGapTacticMapping } from "@/lib/iegp/mapping";
import type { IegpState } from "@/lib/iegp/types";
import { MAPPING_CANDIDATES_DDL, mappingCandidates } from "./schema";
import { plural } from "@/lib/plural";

export const mappingStatusSchema = z.enum(["open", "addressed", "partially_addressed"]);
export type MappingStatus = z.infer<typeof mappingStatusSchema>;

const inputSchema = z.object({
  gap_ids: z.array(z.string()).optional(),
  tactic_ids: z.array(z.string()).optional(),
  /** Optional subset of child scopes; omitted runs include all active children. */
  expansion_ids: z.array(z.string()).optional(),
  /** Maximum tactics assigned per gap row. */
  max_per_gap: z.number().int().min(1).max(20).default(6),
  dry_run: z.boolean().default(false),
});

const coverageSchema = z.enum(OVERALL_COVERAGE);
const modelCoverageSchema = z.enum(ASSESSED_COVERAGE);
const dimensionValueSchema = z.enum(DIMENSION_VALUES);
const dimensionsSchema = z.object(
  Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [dimension, dimensionValueSchema])) as Record<
    (typeof COVERAGE_DIMENSIONS)[number],
    typeof dimensionValueSchema
  >,
);

/** The model's verdict on one gap ↔ tactic pair. */
const tacticMappingSchema = z.object({
  /** Explicit target ID: parent tactic ID or child expansion ID. */
  tactic_id: z.string(),
  parent_tactic_id: z.string().optional(),
  expansion_id: z.string().optional(),
  tactic_name: z.string(),
  /** How much of the gap this tactic covers, in the workspace coverage vocabulary. */
  coverage: coverageSchema,
  confidence: z.number(),
  rationale: z.string(),
  /** Per-dimension coverage; null when the model judged the tactic not relevant. */
  dimensions: dimensionsSchema.nullable(),
  references: z.array(judgementReferenceSchema).optional(),
  /** This reassessment leaves the existing coverage available for human review. */
  review_only: z.boolean().optional(),
  /** Server-authored generation context; absent on legacy proposals. */
  supplied_records: z.array(suppliedJudgementRecordSchema).optional(),
  expected_tactic_version: z.string().optional(),
});

const reviewSchema = z.object({
  verdict: z.enum(["keep", "revise", "drop"]),
  confidence: z.number(),
  note: z.string(),
  mappings: z.array(z.object({ tactic_id: z.string(), verdict: z.enum(["keep", "revise", "drop"]), note: z.string() })),
});

const rowSchema = z.object({
  gap_id: z.string(),
  gap_name: z.string(),
  /** Ordinary mapping suggestions the model judged to bear on the gap. */
  tactic_ids: z.array(z.string()),
  tactic_names: z.array(z.string()),
  /** The model's gap-level verdict for ordinary mapping suggestions. */
  mapping_status: mappingStatusSchema,
  confidence: z.number(),
  rationale: z.array(z.string()),
  /** One verdict per tactic the model assessed for this gap. */
  mappings: z.array(tacticMappingSchema),
  /** The model critic's last review of this row. */
  review: reviewSchema.nullable(),
  verdict: z.string().optional(),
  /** The model judge's reason for accepting or rejecting the row. */
  verdict_note: z.string().optional(),
});

const outputSchema = z.object({
  mode: z.enum(["llm", "deterministic"]),
  proposed: z.number(),
  rows: z.array(rowSchema),
  accepted: z.array(rowSchema),
  rejected: z.array(rowSchema),
  /** Rows the model critic dropped during the dialogue; they never reached the judge. */
  withdrawn: z.array(z.object({ gap_id: z.string(), note: z.string() })),
  committed: z.array(z.object({ gap_id: z.string(), tactic_ids: z.array(z.string()) })),
  table: z.object({
    gaps: z.number(),
    tactics: z.number(),
    rows_accepted: z.number(),
    gaps_still_open: z.number(),
  }),
});

export type MappingInput = z.infer<typeof inputSchema>;
export type MappingOutput = z.infer<typeof outputSchema>;
export type MappingTableRow = z.infer<typeof rowSchema>;
export type TacticMapping = z.infer<typeof tacticMappingSchema>;
export const mappingTableRowSchema = rowSchema;

type Row = Omit<MappingTableRow, "verdict" | "verdict_note">;
type Review = z.infer<typeof reviewSchema>;
type JudgeVerdict = { verdict: "accept" | "reject"; confidence: number; reason: string };

const DIMENSION_KEYS = COVERAGE_DIMENSIONS.join(", ");
const MAX_PAIRS_PER_PROMPT = 24;
const REMEDY = "run S4 again or switch the S4 route in /admin/control.";
const ADDRESSED_STATUS_RULE = 'Use "addressed" only with an ordinary "full" mapping or multiple complementary ordinary mappings that together close the gap, at least one of them "partial". Stale reassessments are review-only and cannot contribute to closure.';

const MAPPING_TABLE_PROPOSER_SYSTEM = `You produce a gap ↔ tactic mapping TABLE for a pharma Integrated Evidence Generation Plan.

Each target has its own id. A target with expansion_id is added scope under parent_tactic_id, not the parent's design. Assess only its supplied question and scope, use its exact target id as tactic_id, and never merge it into the parent question. Proposed expansions may be assessed but do not count toward gap closure until a human plans them.

Each TABLE ROW is one evidence gap. For each gap you are given, decide which tactics bear on it and how much of it they cover:
- mappings: one entry per tactic you assessed for the gap. coverage is "full" (the tactic fully covers the gap), "partial" (covers some of it), "limited" (bears on it but thinly, e.g. population or endpoints too narrow) or "not_relevant" (you considered it and it does not apply). Each mapping needs a confidence (0-100), a one-sentence rationale naming what overlaps or is missing (population, comparator, outcome, timing), and, unless coverage is "not_relevant", a value for every dimension (${DIMENSION_KEYS}) of "yes", "partial", "no" or "unknown". For "not_relevant" set dimensions to null.
- mapping_status: "open" (no ordinary mapping bears on the gap), "addressed" (the ordinary mappings together fully close it) or "partially_addressed" (they cover part of it).
- Exclude reassessments of stale coverage from mapping_status. A "full", "partial" or "limited" ordinary mapping bears on the gap, so a row with any of them is never "open". When the only ordinary mappings that bear on a gap are "limited", the status is "partially_addressed"; if a tactic does not really bear on it, mark that mapping "not_relevant" instead.
- ${ADDRESSED_STATUS_RULE}
- confidence (0-100) and a one-sentence rationale for the row as a whole.

At most max_tactics_per_gap new mappings per gap may have coverage other than "not_relevant". Do not map dissemination-only tactics unless the gap is about dissemination. Tactics already assigned to a gap are listed on it. For each stale_tactic_id, return an explicit mapping assessment against the current design and gap requirements, including "not_relevant" if warranted. Stale assessments are review proposals and do not count against the new mapping limit or change the recorded judgement. A gap may list human_rejected_tactic_ids: a reviewer rejected or removed those tactics for that gap, so never map them to it.

Use only the tactics offered in this request. When partial_row is true, assign a status for just this fragment; a previous row may include a combined status across fragments. When a gap carries a previous row and a critic objection, address the parts of the objection that apply to these tactics: change the mappings or status, or keep them and say why in the rationale.

Return a row for every gap you are given.

Every relevant mapping must include references: [{"entity_type":"gap|objective|source","entity_id":"an ID from supporting_records","reason":"what this supplied record supports"}]. Cite only supporting_records offered for this gap. For not_relevant, use an empty references list if no source is needed. Unsupported judgements cannot be committed; never invent support.

Return JSON only: {"rows":[{"gap_id":"","mapping_status":"open|addressed|partially_addressed","confidence":0,"rationale":"","mappings":[{"tactic_id":"","coverage":"full|partial|limited|not_relevant","confidence":0,"rationale":"","dimensions":${JSON.stringify(Object.fromEntries(COVERAGE_DIMENSIONS.map(dimension => [dimension, "yes"])))}, "references":[{"entity_type":"gap","entity_id":"supplied gap id","reason":"what the record supports"}]}]}]}`;

const COMBINED_COVERAGE_SYSTEM = `Assess how the retained ordinary tactic mappings collectively cover one evidence gap in a pharma Integrated Evidence Generation Plan. These pair assessments came from separate requests. Use only the supplied gap, evidence records and tactic designs. Treat the mappings as fixed; return only their combined status, confidence and rationale.
${ADDRESSED_STATUS_RULE}
Use "partially_addressed" when the evidence still leaves any requirement open. Multiple mappings with the same limitations do not establish closure. Confidence is 0-100; the rationale names the complementary evidence or the requirements that remain open. When an objection is supplied, address its concerns about the combined status.
Return JSON only: {"rows":[{"gap_id":"","mapping_status":"addressed|partially_addressed","confidence":0,"rationale":""}]}.`;

const MAPPING_CRITIC_SYSTEM = `You independently review a proposed gap ↔ tactic mapping table for a pharma Integrated Evidence Generation Plan.

For each row, judge whether each mapping's coverage, dimensions and citations are defensible from the supplied records, gap and tactic design; whether an offered tactic that bears on the gap was left out; and whether the row's mapping_status follows from its mappings. When partial_row is true, other tactics were assessed separately. Review only this fragment and avoid inferring an inconsistency from mappings you cannot see. Review-only mappings reassess stale coverage; they do not amend the record. Never request a mapping for human_rejected_tactic_ids. Use worked_examples (past reviewer decisions on similar cases) for calibration only where a case really matches; they are examples, not rules.

The status rule is fixed: review-only mappings do not affect mapping_status. A "full", "partial" or "limited" ordinary mapping bears on the gap, so a row with any of them cannot be "open". Never ask for "open" while such a mapping stays; to make a row open, ask for those ordinary mappings to become "not_relevant". A gap whose only ordinary bearing tactics are "limited" is "partially_addressed".
For a complete row: ${ADDRESSED_STATUS_RULE}

verdict is "keep" when the row is right, "revise" when a mapping, a coverage value or the status should change, and "drop" when the row cannot be salvaged and should be withdrawn this run. confidence is 0-100 that the row is right. note names what should change and why; for "keep" say briefly why it holds. Give a verdict and note for every mapping in the row under mappings; a "keep" row has only "keep" mappings.

Review every row you are given.

Return JSON only: {"reviews":[{"gap_id":"","verdict":"keep|revise|drop","confidence":0,"note":"","mappings":[{"tactic_id":"","verdict":"keep|revise|drop","note":""}]}]}`;

const MAPPING_JUDGE_SYSTEM = `You are the final judge of a gap ↔ tactic mapping table for a pharma Integrated Evidence Generation Plan. Accepted rows are written into the workspace as tactic assignments that a human then reviews.

For each row, decide "accept" when its mappings, coverage values, citations and status are defensible from the supplied records, gap and tactic text, or "reject" when they are not. When partial_row is true, review only the supplied fragment; other parts of this gap row are judged separately. Review-only mappings reassess stale coverage; they do not amend the record or determine mapping_status. You see the critic's last review; a row marked revised_after_review changed after that review, so judge the row as it stands. confidence is 0-100 in your verdict. reason is one or two sentences.
When combined_coverage is true, the row contains all retained ordinary mappings. Judge their combined coverage and status from the evidence supplied. Fragment reviews handle other findings.
For a complete row: ${ADDRESSED_STATUS_RULE}

Judge every row you are given.

Return JSON only: {"verdicts":[{"gap_id":"","verdict":"accept|reject","confidence":0,"reason":""}]}`;

function subjectOf(row: Row): string {
  return row.gap_id;
}

function candidateSets(state: IegpState, input: MappingInput, development = false) {
  const gaps = state.gaps.filter(
    (gap) =>
      (gapEligibleForMapping(gap.status) || (development && gap.status === "candidate")) &&
      !gap.retired &&
      (!input.gap_ids?.length || input.gap_ids.includes(gap.id)),
  );
  const parents = state.tactics.filter(
    (tactic) =>
      (tacticEligibleForMapping(tactic) || (development && tactic.review_status === "candidate" && tactic.status !== "cancelled")) &&
      (!input.tactic_ids?.length || input.tactic_ids.includes(tactic.id)),
  );
  const children = (state.expansions ?? []).flatMap((child) => {
    const parent = state.tactics.find((t) => t.id === child.tactic_id);
    if (!parent || !tacticEligibleForMapping(parent) || child.status === "cancelled" ||
      (input.tactic_ids?.length && !input.tactic_ids.includes(parent.id)) ||
      (input.expansion_ids?.length && !input.expansion_ids.includes(child.id))) return [];
    return [{...parent, ...child.scope, type: child.scope.type ?? "not_recorded" as const, custom_type: null, comparator: child.scope.comparator ?? "", data_source: child.scope.data_source ?? "", id: child.id, parent_tactic_id: parent.id,
      expansion_id: child.id, gap_ids: child.gap_ids, status: child.status}];
  });
  const tactics: (Omit<IegpState["tactics"][number], "type"> & {type: IegpState["tactics"][number]["type"] | "not_recorded"; parent_tactic_id?: string; expansion_id?: string; gap_ids?: string[]})[] =
    [...(input.expansion_ids?.length ? [] : parents), ...children];
  return { gaps, tactics };
}

type Gap = ReturnType<typeof candidateSets>["gaps"][number];
type TacticRow = ReturnType<typeof candidateSets>["tactics"][number];

const bearsOnGap = (mapping: TacticMapping) => mapping.coverage !== "not_relevant";
const newAssignment = (mapping: TacticMapping) => bearsOnGap(mapping) && !mapping.review_only;

/** Compare opaque IDs in a consistent order across database reads and hosts. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Pairs S4 must leave alone: a person rejected or removed the tactic for the
 * gap. (A pair already assigned, including one whose coverage a person set, is
 * never rewritten: assignTacticToGap refuses an existing pair.)
 */
function blockedPairs(state: IegpState): Set<string> {
  const pairs = humanRejectedPairs(state);
  for (const child of state.expansions ?? []) {
    for (const gapId of child.gap_ids) if (pairs.has(`${gapId}::${child.tactic_id}`) && !humanAcceptedExpansionScope(state, gapId, child.tactic_id, child.id)) pairs.add(`${gapId}::${child.id}`);
  }
  return pairs;
}

const pairKey = (gap_id: string, tactic_id: string) => `${gap_id}::${tactic_id}`;

/**
 * Test stub only (SYNAPSE_TEST_STUB_LLM=1). Every row says no model ran, so a
 * stub mapping cannot pass for a judgement.
 */
function localTableRows(state: IegpState, input: MappingInput): Row[] {
  if (!isTestStub()) throw new NoRouteError("Mapping has no rule-based fallback.");
  const { gaps, tactics } = candidateSets(state, input);
  const covered = new Set(state.coverages.filter((c) => !c.expansion_id || c.overall !== "unassessed").map((c) => pairKey(c.gap_id, c.expansion_id ?? c.tactic_id)));
  const blocked = blockedPairs(state);
  return gaps.map((gap) => {
    const scored = tactics
      .filter((tactic) => (!tactic.gap_ids || tactic.gap_ids.includes(gap.id)) && !covered.has(pairKey(gap.id, tactic.id)) && !blocked.has(pairKey(gap.id, tactic.id)))
      .map((tactic) => ({ tactic, result: scoreGapTacticMapping(gap, tactic, {}) }))
      .filter((item) => item.result.score >= MAPPING_SCORE_FLOOR)
      .sort((a, b) => b.result.score - a.result.score)
      .slice(0, input.max_per_gap);
    const mappings: TacticMapping[] = scored.map(({ tactic, result }) => ({
      tactic_id: tactic.id,
      parent_tactic_id: tactic.parent_tactic_id,
      expansion_id: tactic.expansion_id,
      tactic_name: tactic.name,
      coverage: "partial",
      confidence: 50,
      references: [{ entity_type: "gap", entity_id: gap.id, reason: "The supplied evidence need defines the coverage being assessed." }],
      rationale: `Test stub: no model was called (${result.reasons.slice(0, 2).join("; ")}).`,
      dimensions: Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [dimension, "unknown"])) as TacticMapping["dimensions"],
    }));
    return {
      gap_id: gap.id,
      gap_name: gap.name,
      tactic_ids: mappings.map((mapping) => mapping.tactic_id),
      tactic_names: mappings.map((mapping) => mapping.tactic_name),
      mapping_status: mappings.length ? "partially_addressed" : "open",
      confidence: 50,
      rationale: ["Test stub: no model was called."],
      mappings,
      review: null,
    };
  });
}

type RawMapping = {
  tactic_id?: unknown;
  coverage?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  dimensions?: unknown;
  references?: unknown;
};

type RawRow = {
  gap_id?: unknown;
  mapping_status?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  mappings?: unknown;
};

/**
 * Schema check of one model row. Anything missing, out of vocabulary or
 * inconsistent returns null so the row is asked for again; nothing is filled in.
 */
function parseProposedRow(
  raw: RawRow,
  gap: Gap,
  tactics: TacticRow[],
  maxPerGap: number,
  blocked: Set<string>,
  staleTactics: string[],
  supplied: ReturnType<typeof suppliedJudgementRecords>,
  /** Told why a row is rejected, so the next attempt can say so (KAN-66). */
  onReject: (reason: string) => void = () => {},
): Row | null {
  const reject = (reason: string): null => {
    onReject(reason);
    return null;
  };
  const status = mappingStatusSchema.safeParse(raw.mapping_status);
  if (!status.success) return reject("mapping_status must be open, addressed or partially_addressed.");
  if (!finiteNumber(raw.confidence)) return reject("the row needs a numeric confidence.");
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) return reject("the row needs a rationale.");
  if (!Array.isArray(raw.mappings)) return reject("mappings must be a list.");
  const mappings: TacticMapping[] = [];
  for (const item of raw.mappings as RawMapping[]) {
    const tactic = tactics.find((candidate) => candidate.id === item?.tactic_id);
    if (!tactic) return reject(`tactic ${String(item?.tactic_id)} was not offered for this mapping batch.`);
    if (tactic.gap_ids && !tactic.gap_ids.includes(gap.id)) return reject(`expansion ${tactic.id} does not target this gap.`);
    if (mappings.some((mapping) => mapping.tactic_id === tactic.id)) return reject(`tactic ${tactic.id} is listed twice.`);
    // A person rejected or removed this pair: it is left out, never proposed again.
    if (blocked.has(pairKey(gap.id, tactic.id))) return reject(`tactic ${tactic.id} was rejected by a reviewer for this gap.`);
    const coverage = modelCoverageSchema.safeParse(item.coverage);
    if (!coverage.success) return reject(`coverage for ${tactic.id} must be full, partial, limited or not_relevant.`);
    if (!finiteNumber(item.confidence)) return reject(`the mapping to ${tactic.id} needs a numeric confidence.`);
    const note = typeof item.rationale === "string" ? item.rationale.trim() : "";
    if (!note) return reject(`the mapping to ${tactic.id} needs a rationale.`);
    let dimensions: TacticMapping["dimensions"] = null;
    if (coverage.data !== "not_relevant") {
      const parsed = dimensionsSchema.safeParse(item.dimensions);
      if (!parsed.success) return reject(`the mapping to ${tactic.id} needs a yes/partial/no/unknown value for every dimension.`);
      dimensions = parsed.data;
    }
    const references = inspectSuppliedJudgementReferences(supplied, item.references);
    if (!references.length && (coverage.data !== "not_relevant" || (item.references !== undefined && (!Array.isArray(item.references) || item.references.length > 0)))) {
      return reject(`supporting references for ${tactic.id} must cite only supplied records for this gap.`);
    }
    mappings.push({
      tactic_id: tactic.id,
      parent_tactic_id: tactic.parent_tactic_id,
      expansion_id: tactic.expansion_id,
      tactic_name: tactic.name,
      coverage: coverage.data,
      confidence: clampScore(item.confidence),
      rationale: note,
      references: references.map(({ entity_type, entity_id, reason }) => ({ entity_type, entity_id, reason })),
      ...(staleTactics.includes(tactic.id) ? { review_only: true } : {}),
      dimensions,
    });
  }
  const missingReviews = staleTactics.filter(id => !mappings.some(mapping => mapping.tactic_id === id));
  if (missingReviews.length) return reject(`assess each stale mapping explicitly: ${missingReviews.join(", ")}.`);
  const bearing = mappings.filter(newAssignment);
  if (bearing.length > maxPerGap) return reject(`at most ${maxPerGap} new mappings may be other than not_relevant.`);
  const hasStaleCoverage = mappings.some(mapping => mapping.review_only && bearsOnGap(mapping));
  if (status.data === "open" && bearing.length > 0) {
    return reject(
      `mapping_status is "open" but ${bearing.map((m) => `${m.tactic_id} is "${m.coverage}"`).join(", ")}. A full, partial or limited mapping bears on the gap: use "partially_addressed", or mark those mappings "not_relevant".`,
    );
  }
  if (status.data !== "open" && bearing.length === 0 && !hasStaleCoverage) {
    return reject(`mapping_status is "${status.data}" but no mapping bears on the gap: use "open", or map the tactics that cover it.`);
  }
  if (status.data === "addressed" && bearing.length > 0) {
    const hasFull = bearing.some(mapping => mapping.coverage === "full");
    const couldCombine = bearing.length > 1 && bearing.some(mapping => mapping.coverage === "partial");
    if (!hasFull && !couldCombine) {
      return reject(`mapping_status is "addressed" but the ordinary mappings cannot close the gap. ${ADDRESSED_STATUS_RULE} Use "partially_addressed", or revise the ordinary coverage if the evidence supports it.`);
    }
  }
  return {
    gap_id: gap.id,
    gap_name: gap.name,
    tactic_ids: bearing.map((mapping) => mapping.tactic_id),
    tactic_names: bearing.map((mapping) => mapping.tactic_name),
    // A row without ordinary coverage stays open; otherwise the verdict covers their combined contribution.
    mapping_status: bearing.length ? status.data : "open",
    confidence: clampScore(raw.confidence),
    rationale: [rationale],
    mappings,
    review: null,
  };
}

function promptTactics(tactics: TacticRow[]) {
  return tactics.map((tactic) => ({
    id: tactic.id,
    name: tactic.name,
    type: tactic.type,
    status: tactic.status,
    evidence_question: tactic.evidence_question,
    population: tactic.population,
    comparator: tactic.comparator,
    data_source: tactic.data_source,
    outcomes: tactic.outcomes,
    parent_tactic_id: tactic.parent_tactic_id,
    expansion_id: tactic.expansion_id,
    scope: tactic.expansion_id ? Object.fromEntries(Object.entries(tactic).filter(([key]) =>
      ["study_design", "geography", "data_cut", "analysis", "instrument", "gap_coverage", "cost_effort", "timing", "feasibility_risks", "post_hoc", "protocol_amendment"].includes(key))) : undefined,
  }));
}

function promptMapping(mapping: TacticMapping) {
  return {
    tactic_id: mapping.tactic_id,
    coverage: mapping.coverage,
    confidence: mapping.confidence,
    rationale: mapping.rationale,
    dimensions: mapping.dimensions,
    references: mapping.references,
    review_only: mapping.review_only,
  };
}

function promptRow(row: Row) {
  return {
    mapping_status: row.mapping_status,
    confidence: row.confidence,
    rationale: row.rationale[0] ?? "",
    mappings: row.mappings.map(promptMapping),
  };
}

function objectionOf(critique: Critique, review: Review | undefined): string {
  const mappingNotes = (review?.mappings ?? [])
    .filter((mapping) => mapping.verdict !== "keep")
    .map((mapping) => `${mapping.tactic_id} (${mapping.verdict}): ${mapping.note}`);
  return [critique.note, ...mappingNotes].join("\n");
}

type Shared = {
  ctx: ModuleContext;
  state: IegpState;
  input: MappingInput;
  gapById: Map<string, Gap>;
  tactics: TacticRow[];
  tacticBatch: Map<string, number>;
  fragmentAssessments: Map<string, Pick<Row, "mapping_status" | "confidence" | "rationale">[]>;
  hints: string;
  /** Pairs a person rejected or removed. */
  blocked: Set<string>;
  stale: Map<string, string[]>;
  /** Why the last answer's row for a gap was rejected; sent with the retry (KAN-66). */
  rejections: Map<string, string>;
};

function rejectedFor(shared: Shared, gapId: string): string[] | undefined {
  const ids = shared.tactics.map((tactic) => tactic.id).filter((id) => shared.blocked.has(pairKey(gapId, id)));
  return ids.length ? ids : undefined;
}

/** Only stale relationships that are eligible for the current request need reassessment. */
function staleFor(shared: Shared, gapId: string, targets: TacticRow[]): string[] {
  const stale = shared.stale.get(gapId) ?? [];
  return targets.filter(target => stale.includes(target.id) && (!target.gap_ids || target.gap_ids.includes(gapId))
    && !shared.blocked.has(pairKey(gapId, target.id))).map(target => target.id);
}

function promptGap(shared: Shared, gapId: string, targets: TacticRow[]) {
  const gap = shared.gapById.get(gapId)!;
  const stale = staleFor(shared, gapId, targets);
  return {
    id: gap.id,
    name: gap.name,
    statement: gap.statement,
    domain: gap.domain,
    assigned_tactic_ids: shared.state.coverages.filter((c) => c.gap_id === gap.id).map((c) => c.expansion_id ?? c.tactic_id).sort(compareIds),
    human_rejected_tactic_ids: rejectedFor(shared, gap.id),
    stale_tactic_ids: stale.length ? stale : undefined,
  };
}

async function llmProposals(
  shared: Shared,
  args: { gapIds: string[]; tactics: TacticRow[]; previous: Map<string, Row>; objections: Map<string, string>; retry: boolean },
): Promise<Map<string, Row>> {
  const payload = await shared.ctx.complete({
    role: args.previous.size ? "reviser" : "proposer",
    system: MAPPING_TABLE_PROPOSER_SYSTEM,
    user: JSON.stringify({
      worked_examples: shared.hints || undefined,
      partial_row: shared.tactics.length > MAX_PAIRS_PER_PROMPT || undefined,
      note: args.retry
        ? "An earlier answer left these gaps without a complete, valid row. Each gap's rejected_because says what was wrong; fix exactly that and return a complete row for each."
        : undefined,
      gaps: args.gapIds.map((id) => {
        const previous = args.previous.get(id);
        return {
          ...promptGap(shared, id, args.tactics),
          previous: previous ? promptRow(previous) : undefined,
          objection: args.objections.get(id),
          rejected_because: args.retry ? shared.rejections.get(id) : undefined,
        };
      }),
      tactics: promptTactics(args.tactics),
      supporting_records: suppliedJudgementRecords(shared.state, args.gapIds),
      max_tactics_per_gap: shared.input.max_per_gap,
    }),
    purpose: "mapping-table-proposer",
  });
  const map = new Map<string, Row>();
  for (const [id, raw] of modelRows({
    payload, field: "rows", idField: "gap_id", ids: args.gapIds,
    problems: shared.rejections, report: details => shared.ctx.run.note("answer:invalid", details),
  })) {
    const row = parseProposedRow(raw, shared.gapById.get(id)!, args.tactics, shared.input.max_per_gap, shared.blocked, staleFor(shared, id, args.tactics),
      suppliedJudgementRecords(shared.state, [id]), reason => shared.rejections.set(id, reason));
    if (row) map.set(id, row);
  }
  return map;
}

/** Iterate the complete gap-by-tactic matrix in bounded, stable request slices. */
function* matrixSlices(ids: string[], targets: TacticRow[]) {
  const orderedIds = [...ids].sort(compareIds);
  const gapBatchSize = Math.max(1, Math.floor(MAX_PAIRS_PER_PROMPT / Math.max(1, targets.length)));
  for (let start = 0; start < orderedIds.length; start += gapBatchSize) {
    const batch = orderedIds.slice(start, start + gapBatchSize);
    for (let offset = 0; offset < Math.max(1, targets.length); offset += MAX_PAIRS_PER_PROMPT) {
      yield { ids: batch, tactics: targets.slice(offset, offset + MAX_PAIRS_PER_PROMPT), index: offset / MAX_PAIRS_PER_PROMPT };
    }
  }
}

/** Ask for each matrix slice separately, retaining completed rows within each slice. */
async function completeProposals(
  shared: Shared,
  ids: string[],
  previous: Map<string, Row>,
  objections: Map<string, string>,
): Promise<Map<string, Row>> {
  const rowsByGap = new Map(ids.map(id => [id, [] as Row[]]));
  for (const slice of matrixSlices(ids, shared.tactics)) {
    const tacticIds = new Set(slice.tactics.map(tactic => tactic.id));
    const previousBatch = new Map(slice.ids.flatMap(id => {
      const row = previous.get(id);
      if (!row) return [];
      return [[id, { ...row, mappings: row.mappings.filter(mapping => tacticIds.has(mapping.tactic_id)) }] as const];
    }));
    const rows = await completeAll({
      ids: slice.ids,
      what: "mapping row",
      describe: id => shared.gapById.get(id)?.name ?? id,
      problems: shared.rejections,
      remedy: REMEDY,
      ask: (missing, attempt) => llmProposals(shared, { gapIds: missing, tactics: slice.tactics, previous: previousBatch, objections, retry: attempt > 1 }),
    });
    for (const [id, row] of rows) rowsByGap.get(id)!.push(row);
  }
  const merged = new Map([...rowsByGap].map(([id, rows]): [string, Row] => {
    if (rows.length === 1) return [id, rows[0]!];
    const ranked = rows.flatMap(row => row.mappings.filter(newAssignment))
      .sort((a, b) => b.confidence - a.confidence || compareIds(a.tactic_id, b.tactic_id));
    const selected = ranked.slice(0, shared.input.max_per_gap);
    const selectedIds = new Set(selected.map(mapping => mapping.tactic_id));
    const excluded = ranked.filter(mapping => !selectedIds.has(mapping.tactic_id));
    if (excluded.length) shared.ctx.run.note("mapping:limit", { gap_id: id, assessed_but_above_limit: excluded.map(mapping => mapping.tactic_id) });
    shared.fragmentAssessments.set(id, rows.map(fragment => {
      const retained = fragment.mappings.filter(mapping => selectedIds.has(mapping.tactic_id));
      const sustainsClosure = retained.length === fragment.tactic_ids.length || retained.some(mapping => mapping.coverage === "full");
      const mapping_status = retained.length === 0 ? "open"
        : fragment.mapping_status === "addressed" && sustainsClosure ? "addressed" : "partially_addressed";
      const rationale = mapping_status === fragment.mapping_status ? fragment.rationale
        : ["The mapping limit excluded ordinary mappings that contributed to this fragment's original status."];
      return { mapping_status, confidence: fragment.confidence, rationale };
    }));
    const mappings = rows.flatMap(row => row.mappings).filter(mapping => !newAssignment(mapping) || selectedIds.has(mapping.tactic_id));
    const bearing = mappings.filter(newAssignment);
    const addressed = bearing.some(mapping => mapping.coverage === "full") || rows.some(row =>
      row.mapping_status === "addressed" && row.tactic_ids.every(id => selectedIds.has(id)));
    return [id, {
      ...rows[0]!,
      mappings,
      mapping_status: addressed ? "addressed" : bearing.length ? "partially_addressed" : "open",
      tactic_ids: bearing.map(mapping => mapping.tactic_id),
      tactic_names: bearing.map(mapping => mapping.tactic_name),
      rationale: rows.flatMap(row => row.rationale),
    }];
  }));
  for (const id of [...merged.keys()].sort(compareIds)) {
    const row = merged.get(id)!;
    const coverage = combinedCoverageFor(shared, row);
    if (coverage) {
      merged.set(id, await completeCombinedCoverage(shared, row, coverage, previous.has(id), objections.get(id)));
    }
  }
  return merged;
}

type CombinedCoverage = { mappings: TacticMapping[]; tactics: TacticRow[] };

/** Only multiple retained ordinary mappings from different slices can leave a joint verdict unresolved. */
function combinedCoverageFor(shared: Shared, row: Row): CombinedCoverage | null {
  const ids = new Set(row.tactic_ids);
  if (new Set(row.tactic_ids.map(id => shared.tacticBatch.get(id))).size < 2) return null;
  const mappings = row.mappings.filter(newAssignment);
  if (mappings.some(mapping => mapping.coverage === "full") || !mappings.some(mapping => mapping.coverage === "partial")) return null;
  return { mappings, tactics: shared.tactics.filter(tactic => ids.has(tactic.id)) };
}

/** Obtain the gap-level verdict from at most max_per_gap retained ordinary mappings. */
async function completeCombinedCoverage(
  shared: Shared,
  row: Row,
  coverage: CombinedCoverage,
  revising: boolean,
  objection: string | undefined,
): Promise<Row> {
  const id = row.gap_id;
  const verdict = await completeAll({
    ids: [id],
    what: "combined mapping status",
    describe: () => row.gap_name,
    problems: shared.rejections,
    remedy: REMEDY,
    ask: async (ids, attempt) => {
      const payload = await shared.ctx.complete({
        role: revising ? "reviser" : "proposer",
        system: COMBINED_COVERAGE_SYSTEM,
        user: JSON.stringify({
          worked_examples: shared.hints || undefined,
          gap: promptGap(shared, id, coverage.tactics),
          tactics: promptTactics(coverage.tactics),
          mappings: coverage.mappings.map(promptMapping),
          supporting_records: suppliedJudgementRecords(shared.state, ids),
          objection,
          rejected_because: attempt > 1 ? shared.rejections.get(id) : undefined,
        }),
        purpose: "mapping-table-combined-coverage",
      });
      const raw = modelRows({
        payload, field: "rows", idField: "gap_id", ids,
        problems: shared.rejections, report: details => shared.ctx.run.note("answer:invalid", details),
      }).get(id);
      if (!raw) return new Map();
      const { mapping_status, confidence } = raw;
      const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
      if ((mapping_status !== "addressed" && mapping_status !== "partially_addressed") || !finiteNumber(confidence) || !rationale) {
        shared.rejections.set(id, 'Combined coverage needs an "addressed" or "partially_addressed" status, numeric confidence and rationale.');
        return new Map();
      }
      return new Map([[id, { ...row, mapping_status, confidence: clampScore(confidence), rationale: [rationale, ...row.rationale] }]]);
    },
  });
  return verdict.get(id)!;
}

type ReviewRequest = { rows: Row[]; tactics: TacticRow[]; partial: boolean; retry: boolean; combinedCoverage?: boolean };

/** Review the same bounded slices as proposal generation and keep completed slices through retries. */
async function completeReviews<T>(
  shared: Shared,
  rows: Row[],
  what: string,
  ask: (request: ReviewRequest) => Promise<Map<string, T>>,
  combine: (parts: T[]) => T,
): Promise<Map<string, T>> {
  const byId = new Map(rows.map(row => [row.gap_id, row]));
  const parts = new Map(rows.map(row => [row.gap_id, [] as T[]]));
  const partial = shared.tactics.length > MAX_PAIRS_PER_PROMPT;
  for (const slice of matrixSlices([...byId.keys()], shared.tactics)) {
    const targetIds = new Set(slice.tactics.map(tactic => tactic.id));
    const sliced = new Map(slice.ids.map(id => {
      const row = byId.get(id)!;
      return [id, partial ? {
        ...row,
        ...shared.fragmentAssessments.get(id)![slice.index]!,
        mappings: row.mappings.filter(mapping => targetIds.has(mapping.tactic_id)),
        review: row.review && { ...row.review, mappings: row.review.mappings.filter(mapping => targetIds.has(mapping.tactic_id)) },
      } : row];
    }));
    const answers = await completeAll({
      ids: slice.ids,
      what,
      describe: id => shared.gapById.get(id)?.name ?? id,
      problems: shared.rejections,
      remedy: REMEDY,
      ask: (missing, attempt) => ask({
        rows: missing.map(id => sliced.get(id)!), tactics: slice.tactics, partial, retry: attempt > 1,
      }),
    });
    for (const [id, answer] of answers) parts.get(id)!.push(answer);
  }
  return new Map([...parts].map(([id, answers]) => [id, combine(answers)]));
}

/** A drop or revision in any fragment applies to the full proposal row. */
function combineReviews(parts: Review[]): Review {
  const decision = parts.find(part => part.verdict === "drop") ?? parts.find(part => part.verdict === "revise") ?? parts[0]!;
  return {
    ...decision,
    note: parts.filter(part => part.verdict === decision.verdict).map(part => part.note).join("\n"),
    mappings: parts.flatMap(part => part.mappings),
  };
}

async function llmReviews(
  shared: Shared,
  args: ReviewRequest & { round: number },
): Promise<Map<string, Review>> {
  const payload = (await shared.ctx.complete({
    role: "critic",
    system: MAPPING_CRITIC_SYSTEM,
    user: JSON.stringify({
      worked_examples: shared.hints || undefined,
      partial_row: args.partial || undefined,
      exchange: `${args.round} of ${PROPOSER_CRITIC_EXCHANGES}`,
      note: args.retry
        ? "An earlier answer left these rows unreviewed, gave no verdict for some of their mappings, or objected to a mapping without a note. Review each row and every mapping in it; give a note for every revise or drop."
        : undefined,
      rows: args.rows.map((row) => ({ gap: promptGap(shared, row.gap_id, args.tactics), ...promptRow(row), rejected_because: args.retry ? shared.rejections.get(row.gap_id) : undefined })),
      tactics: promptTactics(args.tactics),
      supporting_records: suppliedJudgementRecords(shared.state, args.rows.map(row => row.gap_id)),
      max_tactics_per_gap: shared.input.max_per_gap,
    }),
    purpose: "mapping-table-critic",
  }));
  const verdicts = reviewSchema.shape.verdict;
  const map = new Map<string, Review>();
  const byId = new Map(args.rows.map(row => [row.gap_id, row]));
  for (const [id, raw] of modelRows({
    payload, field: "reviews", idField: "gap_id", ids: [...byId.keys()],
    problems: shared.rejections, report: details => shared.ctx.run.note("answer:invalid", details),
  })) {
    const row = byId.get(id)!;
    shared.rejections.set(id, "Review must include a verdict, confidence, note and one valid entry per mapping.");
    const verdict = verdicts.safeParse(raw.verdict);
    if (!verdict.success || !finiteNumber(raw.confidence)) continue;
    const note = typeof raw.note === "string" ? raw.note.trim() : "";
    if (!note) continue;
    const mappings: Review["mappings"] = [];
    let valid = Array.isArray(raw.mappings) || row.mappings.length === 0;
    const seen = new Set<string>();
    for (const item of (Array.isArray(raw.mappings) ? raw.mappings : []) as { tactic_id?: string; verdict?: unknown; note?: unknown }[]) {
      const target = args.tactics.find(tactic => tactic.id === item?.tactic_id);
      if (!target || (target.gap_ids && !target.gap_ids.includes(id)) || shared.blocked.has(pairKey(id, target.id))) {
        shared.rejections.set(id, `Review names tactic ${String(item?.tactic_id)}, which was not offered for this gap.`);
        valid = false;
        break;
      }
      // An omitted, in-scope tactic can be mentioned in the row note (KAN-69).
      if (!row.mappings.some((mapping) => mapping.tactic_id === item?.tactic_id)) {
        shared.ctx.run.note("answer:invalid", { field: "reviews.mappings", id, problem: `tactic ${target.id} was not part of this mapping row` });
        continue;
      }
      if (seen.has(item.tactic_id!)) {
        shared.rejections.set(id, `Duplicate review for tactic ${item.tactic_id}.`);
        valid = false;
        break;
      }
      seen.add(item.tactic_id!);
      const mappingVerdict = verdicts.safeParse(item?.verdict);
      const mappingNote = typeof item?.note === "string" ? item.note.trim() : "";
      // An objection needs its reason; a plain "keep" may stand without one (KAN-69).
      if (!mappingVerdict.success || (!mappingNote && mappingVerdict.data !== "keep")) {
        valid = false;
        break;
      }
      mappings.push({ tactic_id: item.tactic_id as string, verdict: mappingVerdict.data, note: mappingNote });
    }
    // Every mapping in the row needs its own verdict, and a kept row cannot object to one.
    if (!valid || row.mappings.some((mapping) => !mappings.some((item) => item.tactic_id === mapping.tactic_id))) continue;
    if (verdict.data === "keep" && mappings.some((item) => item.verdict !== "keep")) continue;
    shared.rejections.delete(id);
    map.set(row.gap_id, { verdict: verdict.data, confidence: clampScore(raw.confidence), note, mappings });
  }
  return map;
}

async function llmVerdicts(
  shared: Shared,
  args: ReviewRequest & { revised: Set<string> },
): Promise<Map<string, JudgeVerdict>> {
  const payload = (await shared.ctx.complete({
    role: "internal_judge",
    system: MAPPING_JUDGE_SYSTEM,
    user: JSON.stringify({
      worked_examples: shared.hints || undefined,
      partial_row: args.partial || undefined,
      combined_coverage: args.combinedCoverage || undefined,
      note: args.retry ? "An earlier answer left these rows without a verdict. Judge each." : undefined,
      rows: args.rows.map((row) => ({
        gap: promptGap(shared, row.gap_id, args.tactics),
        ...promptRow(row),
        rejected_because: args.retry ? shared.rejections.get(row.gap_id) : undefined,
        last_review: row.review ? { verdict: row.review.verdict, note: row.review.note, mappings: row.review.mappings } : undefined,
        revised_after_review: args.revised.has(row.gap_id),
      })),
      tactics: promptTactics(args.tactics),
      supporting_records: suppliedJudgementRecords(shared.state, args.rows.map(row => row.gap_id)),
    }),
    purpose: "mapping-table-judge",
  }));
  const map = new Map<string, JudgeVerdict>();
  for (const [id, raw] of modelRows({
    payload, field: "verdicts", idField: "gap_id", ids: args.rows.map(row => row.gap_id),
    problems: shared.rejections, report: details => shared.ctx.run.note("answer:invalid", details),
  })) {
    shared.rejections.set(id, "Judgement needs an accept/reject verdict, confidence and reason.");
    if (raw.verdict !== "accept" && raw.verdict !== "reject") continue;
    if (!finiteNumber(raw.confidence)) continue;
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (!reason) continue;
    shared.rejections.delete(id);
    map.set(id, { verdict: raw.verdict, confidence: clampScore(raw.confidence), reason });
  }
  return map;
}

export const kgMappingModule: SynapseModule<MappingInput, MappingOutput> = {
  manifest: {
    id: "s4-kg-mapping.scored-pcj",
    stage: "S4",
    version: "3.3.0",
    title: "LLM mapping table (proposer ↔ critic ×3 → judge)",
    summary:
      "A model proposes one row per gap with a coverage verdict, confidence and rationale for each tactic; a model critic challenges each row over three exchanges and a model judge accepts or rejects it. Needs a connected LLM.",
    contract: 1,
    agentic: true,
    capabilities: ["mapping-table", "llm-proposer", "llm-critic", "llm-judge", "worked-examples"],
  },
  inputSchema,
  outputSchema,
  migrations: [MAPPING_CANDIDATES_DDL],
  freeze: freezeFacts,
  async run(input, ctx) {
    requireLlm(ctx, "Mapping");
    const { state } = (ctx.replay?.facts as Awaited<ReturnType<typeof freezeFacts>> | undefined) ?? await freezeFacts(input);
    const { gaps, tactics } = candidateSets(state, input, ctx.execution_scope === "development" && ctx.replay?.evaluation === true);
    const gapById = new Map(gaps.map((gap) => [gap.id, gap]));
    const describeGap = (id: string) => gapById.get(id)?.name ?? id;
    // The kernel hands similar past reviewer decisions (worked examples, KAN-79) to the proposer; the critic and judge see them too.
    const stale = new Map<string, string[]>();
    for (const coverage of state.coverages) {
      if (!coverage.stale) continue;
      const ids = stale.get(coverage.gap_id) ?? [];
      ids.push(coverage.expansion_id ?? coverage.tactic_id);
      stale.set(coverage.gap_id, ids);
    }
    const orderedTactics = [...tactics].sort((a, b) => compareIds(a.id, b.id));
    const tacticBatch = new Map(orderedTactics.map((tactic, index) => [tactic.id, Math.floor(index / MAX_PAIRS_PER_PROMPT)]));
    const shared: Shared = { ctx, state, input, gapById, tactics: orderedTactics, tacticBatch, fragmentAssessments: new Map(), hints: "", blocked: blockedPairs(state), stale, rejections: new Map() };
    const reviewByGap = new Map<string, Review>();
    const judgeVerdicts = new Map<string, JudgeVerdict>();

    const outcome = await runAgenticCycle<Row>(ctx, "S4", {
      subjectOf,
      proposer: {
        local: ({ round, previous }) => (round === 1 ? localTableRows(state, input) : previous),
        llm: async ({ hints, round, critiques, previous }) => {
          shared.hints = hints;
          if (round === 1) {
            const ids = gaps.map((gap) => gap.id);
            const rows = await completeProposals(shared, ids, new Map(), new Map());
            return ids.map((id) => rows.get(id)!);
          }
          // The critic is a model: its drops are conceded and its revisions answered.
          const dropped = new Set(critiques.filter((c) => c.verdict === "drop").map((c) => c.subject));
          const kept = previous
            .filter((row) => !dropped.has(row.gap_id))
            .map((row) => ({ ...row, review: reviewByGap.get(row.gap_id) ?? row.review }));
          const objections = new Map(
            critiques
              .filter((c) => c.verdict === "revise" && kept.some((row) => row.gap_id === c.subject))
              .map((c) => [c.subject, objectionOf(c, reviewByGap.get(c.subject))]),
          );
          let next = kept;
          if (objections.size > 0) {
            const byId = new Map(kept.map((row) => [row.gap_id, row]));
            const revisions = await completeProposals(shared, [...objections.keys()], byId, objections);
            next = kept.map((row) => {
              const revised = revisions.get(row.gap_id);
              return revised ? { ...revised, review: row.review } : row;
            });
          }
          // The kernel's judge step is synchronous, so the model judge rules on the
          // final rows here, right after the last revision, and the judge reads it.
          if (round === PROPOSER_CRITIC_EXCHANGES + 1 && next.length > 0) {
            const revised = new Set(objections.keys());
            const verdicts = await completeReviews(shared, next, "judge verdict",
              request => llmVerdicts(shared, { ...request, revised }),
              parts => parts.find(part => part.verdict === "reject") ?? parts[0]!);
            for (const row of [...next].sort((a, b) => compareIds(a.gap_id, b.gap_id))) {
              if (verdicts.get(row.gap_id)?.verdict === "reject") continue;
              const coverage = combinedCoverageFor(shared, row);
              if (!coverage) continue;
              const coverageRow = {
                ...row,
                mappings: coverage.mappings,
                review: row.review && {
                  ...row.review,
                  mappings: row.review.mappings.filter(mapping => row.tactic_ids.includes(mapping.tactic_id)),
                },
              };
              const combined = await completeAll({
                ids: [row.gap_id],
                what: "combined mapping judge verdict",
                describe: describeGap,
                problems: shared.rejections,
                remedy: REMEDY,
                ask: (_, attempt) => llmVerdicts(shared, {
                  rows: [coverageRow], tactics: coverage.tactics, partial: false, retry: attempt > 1, revised, combinedCoverage: true,
                }),
              });
              verdicts.set(row.gap_id, combined.get(row.gap_id)!);
            }
            for (const [id, verdict] of verdicts) judgeVerdicts.set(id, verdict);
            ctx.run.note("judge:model", [...verdicts].map(([gap_id, verdict]) => ({ gap_id, ...verdict })));
          }
          return next;
        },
      },
      critic: async (rows, round) => {
        if (isTestStub()) {
          return rows.map((row) => ({
            subject: subjectOf(row),
            verdict: "keep" as const,
            note: "Test stub: no model critic was called.",
            score: 50,
          }));
        }
        const reviews = await completeReviews(shared, rows, "review",
          request => llmReviews(shared, { ...request, round }), combineReviews);
        return rows.map((row) => {
          const review = reviews.get(row.gap_id)!;
          reviewByGap.set(row.gap_id, review);
          return {
            subject: subjectOf(row),
            verdict: review.verdict,
            note: review.note,
            score: review.confidence,
            issues: review.mappings
              .filter((mapping) => mapping.verdict !== "keep")
              .map((mapping) => `${mapping.verdict}:${mapping.tactic_id}`),
          };
        });
      },
      /** Carries the model judge's verdict; no rule decides acceptance. */
      judge: ({ candidates }) =>
        candidates.map((row) => {
          if (isTestStub()) {
            return {
              candidate: row,
              subject: subjectOf(row),
              verdict: "accept" as const,
              score: 50,
              note: "Test stub: no model judge was called.",
            };
          }
          const verdict = judgeVerdicts.get(row.gap_id);
          if (!verdict) throw new Error(`The model judge gave no verdict for ${describeGap(row.gap_id)}.`);
          return {
            candidate: row,
            subject: subjectOf(row),
            verdict: verdict.verdict,
            score: verdict.confidence,
            note: verdict.reason,
          };
        }),
    }, { kinds: ["s4_mapping"], text: gaps.map((gap) => `${gap.name} ${gap.statement}`).join(" ") });

    if (ctx.execution_policy === "single_pass") return {
      output: { mode: outcome.mode, proposed: outcome.proposed.length, rows: outcome.unreviewed, accepted: [], rejected: [], withdrawn: [], committed: [], table: { gaps: gaps.length, tactics: tactics.length, rows_accepted: 0, gaps_still_open: 0 } },
      agentic: outcome, summary: `${outcome.unreviewed.length} unreviewed mapping row(s)`, evals: outcome.metrics,
    };

    const created_at = nowIso();
    const rows = outcome.judged.flatMap((item) => {
      const base = {
        run_id: ctx.run.id,
        gap_id: item.candidate.gap_id,
        score: item.score,
        verdict: item.verdict,
        committed: false,
        proposer: outcome.mode,
        created_at,
      };
      const rowNote = [`status:${item.candidate.mapping_status}`, `row:${item.candidate.rationale[0] ?? ""}`, `judge:${item.note}`];
      if (item.candidate.mappings.length === 0) {
        return [{ ...base, id: newId("mc"), tactic_id: "", confidence: item.candidate.confidence, rationale: rowNote }];
      }
      return item.candidate.mappings.map((mapping) => ({
        ...base,
        id: newId("mc"),
        tactic_id: mapping.tactic_id,
        confidence: mapping.confidence,
        rationale: [mapping.rationale, `coverage:${mapping.coverage}`, ...rowNote],
      }));
    });
    if (!ctx.replay?.evaluation && rows.length > 0) await db().insert(mappingCandidates).values(rows);

    const committed: { gap_id: string; tactic_ids: string[] }[] = [];
    if (!ctx.replay?.evaluation && !input.dry_run) {
      await withWorkspaceTransaction(async () => {
        const assignments = outcome.accepted.flatMap(row => row.mappings.filter(newAssignment)
          .filter(mapping => !shared.blocked.has(pairKey(row.gap_id, mapping.tactic_id)))
          .map(mapping => ({ gap_id: row.gap_id, tactic_id: mapping.parent_tactic_id ?? mapping.tactic_id })));
        // A batch must own all parent designs before its first gap/coverage write.
        await lockRelationships();
        // Match Setup before taking tactic/objective rows.
        await db().execute(sql`LOCK TABLE gaps IN ROW EXCLUSIVE MODE`);
        for (const id of [...new Set(assignments.map(item => item.tactic_id))].sort()) {
          await db().execute(sql`SELECT id FROM tactics WHERE id = ${id} FOR UPDATE`);
        }
        const supplied = suppliedJudgementRecords(shared.state, assignments.map(item => item.gap_id));
        for (const kind of ["objective", "source"] as const) {
          const table = kind === "objective" ? "objectives" : "sources";
          for (const id of [...new Set(supplied.filter(record => record.entity_type === kind).map(record => record.entity_id))].sort()) {
            await db().execute(sql`SELECT id FROM ${sql.raw(table)} WHERE id = ${id} FOR UPDATE`);
          }
        }
        await lockAssessmentOwners({ tactic_ids: assignments.map(item => item.tactic_id), gap_ids: assignments.map(item => item.gap_id) });
        for (const row of outcome.accepted) {
          const joined: string[] = [];
          for (const mapping of row.mappings.filter(newAssignment)) {
            if (shared.blocked.has(pairKey(row.gap_id, mapping.tactic_id))) continue;
            try {
              await assignTacticToGap({
                gap_id: row.gap_id,
                tactic_id: mapping.parent_tactic_id ?? mapping.tactic_id,
                expansion_id: mapping.expansion_id,
                actor_name: ctx.actor.name,
                actor_function: ctx.actor.function,
                note: `S4 mapping table · ${row.mapping_status} · ${mapping.coverage} · ${mapping.rationale}`,
                // The model's verdict is the coverage; the store no longer invents one.
                coverage: mapping.coverage,
                assessment_origin: "ai",
                creation_run_id: ctx.run.id,
                dimensions: mapping.dimensions,
                references: mapping.references,
                model: true,
                supplied_records: suppliedJudgementRecords(shared.state, [row.gap_id]),
                expected_tactic_version: tacticEditVersion(shared.state.tactics.find(tactic => tactic.id === (mapping.parent_tactic_id ?? mapping.tactic_id))!),
              });
              joined.push(mapping.tactic_id);
            } catch (error) {
              ctx.run.note("commit:skipped", {
                gap_id: row.gap_id,
                tactic_id: mapping.tactic_id,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (joined.length > 0) committed.push({ gap_id: row.gap_id, tactic_ids: joined });
        }
      });
    }

    const toOut = (item: (typeof outcome.judged)[number]): MappingTableRow => ({
      ...item.candidate,
      mappings: item.candidate.mappings.map(mapping => ({
        ...mapping,
        supplied_records: suppliedJudgementRecords(shared.state, [item.candidate.gap_id]),
        expected_tactic_version: tacticEditVersion(shared.state.tactics.find(tactic => tactic.id === (mapping.parent_tactic_id ?? mapping.tactic_id))!),
      })),
      verdict: item.verdict,
      verdict_note: item.note,
    });

    const acceptedRows = outcome.judged.filter((item) => item.verdict === "accept").map(toOut);
    const gapsWithTactics = new Set(
      acceptedRows.filter((row) => row.tactic_ids.length > 0).map((row) => row.gap_id),
    );

    return {
      agentic: outcome,
      output: {
        mode: outcome.mode,
        proposed: outcome.proposed.length,
        rows: outcome.judged.map(toOut),
        accepted: acceptedRows,
        rejected: outcome.rejected.map(toOut),
        withdrawn: outcome.withdrawn.map((item) => ({ gap_id: item.subject, note: item.note })),
        committed,
        table: {
          gaps: gaps.length,
          tactics: tactics.length,
          rows_accepted: acceptedRows.length,
          gaps_still_open: gaps.filter(
            (gap) =>
              !gapsWithTactics.has(gap.id) && !state.coverages.some((coverage) => coverage.gap_id === gap.id),
          ).length,
        },
      },
      summary: `${acceptedRows.length} of ${plural(outcome.proposed.length, "mapping row")} accepted${
        input.dry_run ? " (dry run)" : `, ${plural(committed.length, "gap row")} joined`
      }`,
      evals: [
        ...outcome.metrics,
        {
          name: "gap_coverage",
          value:
            gaps.length === 0
              ? 0
              : Number(
                  (
                    gaps.filter(
                      (gap) =>
                        gapsWithTactics.has(gap.id) ||
                        state.coverages.some((coverage) => coverage.gap_id === gap.id),
                    ).length / gaps.length
                  ).toFixed(3),
                ),
          unit: "ratio",
          target: 0.6,
        },
      ],
    };
  },
  evals: {
    async reserveGold(facts, subject_ids) {
      const source = facts as Awaited<ReturnType<typeof freezeFacts>>;
      const { gaps } = candidateSets(source.state, inputSchema.parse({ gap_ids: subject_ids }));
      const ids = gaps.filter(gap => subject_ids.includes(gap.id)).map(gap => gap.id);
      const state = Object.fromEntries(Object.entries(source.state).map(([key, value]) =>
        [key, key === "gaps" ? gaps.filter(gap => ids.includes(gap.id))
          : key === "coverages" ? source.state.coverages.filter(row => ids.includes(row.gap_id))
          : key === "mapping_suggestions" ? source.state.mapping_suggestions.filter(row => ids.includes(row.gap_id))
          : key === "tactics" || key === "asset" ? value : Array.isArray(value) ? [] : value],
      )) as typeof source.state;
      return {
        facts: { state }, subject_ids: ids,
        // Rationale/selectivity ratios and unmapped counts keep the existing
        // definitions; their population is precisely these withheld gaps.
        cases: ids.length ? [{ name: "heldout-mapping-gaps", input: { gap_ids: ids, max_per_gap: 6, dry_run: true } }] : [],
      };
    },
    async cases() {
      return [{ name: "workspace", input: { max_per_gap: 6, dry_run: true } }];
    },
    score({ output }) {
      const withRationale = output.accepted.filter((row) => row.rationale.length > 0).length;
      if (output.accepted.length === 0) {
        return [
          { name: "rows_with_rationale", value: 0, unit: "ratio", detail: "no new rows" },
          { name: "selectivity", value: 0, unit: "ratio", detail: "no new rows" },
          { name: "gaps_left_unmapped", value: output.table.gaps_still_open, unit: "count" },
        ];
      }
      const judged = output.accepted.length + output.rejected.length;
      return [
        {
          name: "rows_with_rationale",
          value: Number((withRationale / output.accepted.length).toFixed(3)),
          unit: "ratio",
          target: 1,
        },
        {
          name: "selectivity",
          value: judged === 0 ? 0 : Number((output.accepted.length / judged).toFixed(3)),
          unit: "ratio",
        },
        {
          name: "gaps_left_unmapped",
          value: output.table.gaps_still_open,
          unit: "count",
        },
      ];
    },
  },
};

registerModule(kgMappingModule);

export async function listMappingCandidates(limit = 300) {
  await ensurePlatformSchema([MAPPING_CANDIDATES_DDL]);
  return db().select().from(mappingCandidates).orderBy(desc(mappingCandidates.created_at)).limit(limit);
}

/** Freeze the source facts this stage consumes, before any proposal or human decision. */
async function freezeFacts(input: z.infer<typeof inputSchema>) {
  return { state: await loadState() };
}

/** Build isolated coverage using the real dimension and citation contracts, without human adoption. */
export function developmentMappingCoverages(state: IegpState, rows: MappingTableRow[], runId: string): IegpState["coverages"] {
  return rows.flatMap(row => {
    if (!state.gaps.some(gap => gap.id === row.gap_id)) throw new Error("Mapping names an unknown gap.");
    return row.mappings.filter(mapping => !mapping.review_only).map(mapping => {
      if (!state.tactics.some(tactic => tactic.id === (mapping.parent_tactic_id ?? mapping.tactic_id))) throw new Error("Mapping names an unknown tactic.");
      const referencesRequired = mapping.coverage !== "not_relevant" || Boolean(mapping.references?.length);
      if (referencesRequired && !inspectSuppliedJudgementReferences(suppliedJudgementRecords(state, [row.gap_id]), mapping.references).length) throw new Error("Mappings require valid supplied-record references; relevant mappings require at least one.");
      const dimensions = emptyDimensions();
      if (mapping.dimensions) for (const dimension of COVERAGE_DIMENSIONS) dimensions[dimension] = { value: mapping.dimensions[dimension], rationale: mapping.rationale, lock: unlocked() };
      return { id: `${runId}:${row.gap_id}:${mapping.tactic_id}`, creation_run_id: runId, human_adopted: false, assessment_origin: "ai" as const, gap_id: row.gap_id, tactic_id: mapping.parent_tactic_id ?? mapping.tactic_id, expansion_id: mapping.expansion_id ?? null, dimensions, overall: mapping.coverage, overall_rationale: mapping.rationale, overall_lock: unlocked(), stale: false, needs_review: false };
    });
  });
}
