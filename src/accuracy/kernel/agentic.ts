import { z } from "zod";
import type { JsonCompletion, RunHandle, TokenUsage } from "../kernel/contracts";
import { validateExperimentCycleControl } from "./contracts";
import type { CriticIssue, ProductionSignals, StructuralFate, StructuralIssueResolution } from "./agent-events";
import { assessStructuralFate, structuralIssueKey, type OpenStructuralIssue, type StructuralCheck } from "./structural-fate";
import { validateProvenance, type ProvenanceSpan } from "../store/quote-validator";
import type { SnapshotCompletenessAssessment, SuspectedOmission } from "../modules/completeness-audit/snapshot-inspector";

const notApplicable: SnapshotCompletenessAssessment = {
  risk_level: "not_applicable", checked_block_ids: [], unchecked_block_ids: [],
  suspected_omissions: [], prior_issue_resolutions: [],
};

/** Preserve open omissions when an assessment cannot be completed. */
function failedAssessment(prior: SuspectedOmission[]): SnapshotCompletenessAssessment {
  return {
    risk_level: "check_failed", checked_block_ids: [], unchecked_block_ids: [],
    suspected_omissions: prior,
    prior_issue_resolutions: prior.map((issue) => ({ issue_id: issue.issue_id,
      outcome: "unresolved", reason: "Completeness assessment failed." })),
  };
}

/** Keep source evidence and requested action in revision feedback and the critique event. */
function omissionIssue(omission: SuspectedOmission): CriticIssue {
  return {
    issue_id: omission.issue_id, category: "omission", code: `missing_${omission.item_kind}`,
    severity: "high",
    claim: `Missing ${omission.item_kind}: ${omission.summary}. Source ${omission.source_ref.source_file_id}/${omission.source_ref.block_id}: "${omission.evidence_quote}". ${omission.reason}`,
    source_ref: omission.source_ref, suggested_action: omission.suggested_action,
  };
}

/** Check available source blocks while keeping missing blocks explicitly unchecked. */
export function inspectQuoteSpans(args: {
  spans: ProvenanceSpan[];
  blocks: { id: string; source_file_id: string; text: string }[];
}): { signals: ProductionSignals["quote_validity"]; findings: { span: ProvenanceSpan; code: string }[] } {
  const blocks = new Map(args.blocks.map((block) => [block.id, block]));
  const signals = { valid_count: 0, invalid_count: 0, unchecked_count: 0 };
  const findings: { span: ProvenanceSpan; code: string }[] = [];
  for (const span of args.spans) {
    const block = blocks.get(span.block_id);
    if (!block) { signals.unchecked_count++; continue; }
    const checked = validateProvenance({ block: { ...block, workspace_id: "", index: 0,
      kind: "prose", heading: null }, span });
    if (checked.ok) signals.valid_count++;
    else { signals.invalid_count++; findings.push({ span, code: checked.reason }); }
  }
  return { signals, findings };
}

/** Immutable production observations for an actually produced version. */
export type RetainedCandidate<T> = {
  iteration: number;
  draft: T;
  signals: ProductionSignals;
  assessment: { score: number | null; issues: CriticIssue[]; completeness: SnapshotCompletenessAssessment; structural_fate?: StructuralFate };
};

export type SnapshotSelection = { selected_iteration: number; reason: string };
const selectionSchema = z.strictObject({ selected_iteration: z.number().int().nonnegative(),
  reason: z.string().trim().min(1) });

function immutable<V>(value: V): V {
  const copy = structuredClone(value);
  const freeze = (node: unknown) => {
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) freeze(child);
      Object.freeze(node);
    }
  };
  freeze(copy);
  return copy;
}

/** Omissions remain review findings; broken content or unavailable checks cannot be selected. */
export function isAdmissibleSnapshot<T>(candidate: RetainedCandidate<T>): boolean {
  const { signals, assessment } = candidate;
  return signals.quote_validity.invalid_count === 0 && signals.quote_validity.unchecked_count === 0
    && signals.invariant_failures.length === 0
    && assessment.score !== null && Number.isFinite(assessment.score)
    && assessment.score >= 0 && assessment.score <= 1
    && assessment.issues.every(issue => issue.category === "omission"
      // An empty proposal requests another pass; the source audit decides whether it omitted anything.
      || (issue.category === "need_extract" && issue.code === "no_gaps_proposed")
      || (issue.category === "inventory_extract" && issue.code === "no_tactics_proposed"))
    && assessment.completeness.checked_block_ids.length > 0
    && assessment.completeness.risk_level !== "check_failed"
    && assessment.completeness.risk_level !== "not_applicable";
}

export type AgenticExchangeResult<T> = {
  final: T;
  selected_iteration: number;
  selected_assessment: RetainedCandidate<T>["assessment"];
  exchanges: number;
  trace: string[];
};

/**
 * Default extraction depth: one propose, one checklist critic, one revise.
 * Hillclimb can raise `maxExchanges` per module eval scores.
 */
export async function runShallowAgenticCycle<T extends object>(args: {
  run: RunHandle;
  onSnapshot: (draft: T, iteration: number) => Promise<ProductionSignals>;
  maxExchanges?: number;
  proposer: (round: number, prior: T | null, critiques: string[]) => Promise<T>;
  critic: (draft: T, prior_open_issues: readonly CriticIssue[]) => Promise<{ score: number; issues: CriticIssue[];
    observationIssues?: CriticIssue[]; check?: StructuralCheck; prior_issue_resolutions?: unknown[] }>;
  /** Responsible assessment must independently validate evidence before a supplied fate is accepted. */
  validateStructuralResolution?: (draft: T, resolution: StructuralIssueResolution) => Promise<boolean>;
  onCompleteness?: (draft: T, prior_open_issues: SuspectedOmission[]) => Promise<SnapshotCompletenessAssessment>;
  /** Legacy latest-version transformation for callers such as ideate. */
  judge?: (draft: T) => Promise<T>;
  /** A decision only: content is always resolved from the retained snapshot. */
  select?: (candidates: readonly RetainedCandidate<T>[]) => Promise<unknown>;
}): Promise<AgenticExchangeResult<T>> {
  const control = validateExperimentCycleControl(args.run.experiment_cycle_control, args.run.evaluation_context ?? "production");
  const max = control?.critic_revision_passes ?? args.maxExchanges ?? 1;
  if (!Number.isInteger(max) || max < 0) throw new RangeError("maxExchanges must be a nonnegative integer");
  const trace: string[] = [];
  const candidates: RetainedCandidate<T>[] = [];
  const measure = async <V>(fn: () => Promise<V>) => {
    const before = args.run.usageSummary();
    const began = Date.now();
    const value = await fn();
    const after = args.run.usageSummary();
    const token_usage: TokenUsage = {
      prompt_tokens: after.token_usage.prompt_tokens - before.token_usage.prompt_tokens,
      completion_tokens: after.token_usage.completion_tokens - before.token_usage.completion_tokens,
      total_tokens: after.token_usage.total_tokens - before.token_usage.total_tokens,
    };
    return { value, latency_ms: Date.now() - began, token_usage,
      cost_usd: Math.max(0, Number((after.cost_usd - before.cost_usd).toFixed(12))) };
  };
  const snapshot = async (draft: T, iteration: number, metering: Awaited<ReturnType<typeof measure<T>>>) => {
    const signals = immutable(await args.onSnapshot(structuredClone(draft), iteration));
    await args.run.recordAgentEvent({ event_type: "snapshot", iteration, output: immutable(draft),
      evaluation_context: args.run.evaluation_context ?? "production", signals, latency_ms: metering.latency_ms,
      token_usage: metering.token_usage, cost_usd: metering.cost_usd });
    return signals;
  };
  const initial = await measure(() => args.proposer(0, null, []));
  let draft = immutable(initial.value);
  let snapshotSignals = await snapshot(draft, 0, initial);
  trace.push("round0:proposer");
  let selectedIteration = 0;
  let priorOpenIssues: SuspectedOmission[] = [];
  let priorStructural: OpenStructuralIssue[] = [];
  for (let iteration = 0; iteration <= max; iteration++) {
    // Every produced version receives a structural and completeness assessment.
    const assessed = await measure(async () => {
      let structural: Awaited<ReturnType<typeof args.critic>> | null = null;
      let structuralError: unknown;
      let structuralFailed = false;
      try {
        structural = await args.critic(structuredClone(draft), structuredClone(priorStructural.map(row => row.issue)));
      } catch (error) {
        structuralError = error;
        structuralFailed = true;
      }
      let completeness = notApplicable;
      if (args.onCompleteness) {
        try {
          completeness = await args.onCompleteness(structuredClone(draft), structuredClone(priorOpenIssues));
        } catch {
          completeness = failedAssessment(priorOpenIssues);
        }
      }
      return { structural, completeness, structuralError, structuralFailed };
    });
    const { structural, completeness, structuralError, structuralFailed } = assessed.value;
    const importantIssues = completeness.suspected_omissions
      .filter((issue) => issue.importance === "important").map(omissionIssue);
    const fate = await assessStructuralFate({ prior: priorStructural,
      current: [...(structural?.issues ?? []), ...(structural?.observationIssues ?? [])].filter(issue => issue.category !== "omission"),
      check: structural?.check, failed: structuralFailed, dispositions: structural?.prior_issue_resolutions,
      feedback_keys: new Set((structural?.issues ?? []).map(structuralIssueKey)),
      validate: args.validateStructuralResolution
        ? resolution => args.validateStructuralResolution!(structuredClone(draft), resolution) : undefined });
    priorStructural = fate.open;
    const assessment = immutable({ score: structural?.score ?? null,
      issues: [...fate.open.map(row => row.issue), ...importantIssues], completeness,
      structural_fate: { status: "assessed" as const, check: structural?.check ?? null, prior_issue_resolutions: fate.resolutions } });
    candidates.push(immutable({ iteration, draft, signals: snapshotSignals, assessment }));
    await args.run.recordAgentEvent({ event_type: "critique", iteration,
      ...assessment, latency_ms: assessed.latency_ms,
      token_usage: assessed.token_usage, cost_usd: assessed.cost_usd });
    if (structuralFailed) throw structuralError;
    priorOpenIssues = assessment.completeness.suspected_omissions;
    if (structural) trace.push(`round${iteration + 1}:critic`);
    if (iteration === max || !structural) break;
    if (!control && !fate.open.some(row => row.feedback) && structural.score >= 0.85 && importantIssues.length === 0) break;
    const feedback = [
      ...fate.open.filter(row => row.feedback).map(({ issue }) => issue.claim),
      ...importantIssues.map((issue) => `${issue.claim} Action: ${issue.suggested_action}`),
    ];
    const revised = await measure(() => args.proposer(iteration + 1, structuredClone(draft), feedback));
    draft = immutable(revised.value);
    selectedIteration = iteration + 1;
    snapshotSignals = await snapshot(draft, selectedIteration, revised);
    trace.push(`round${iteration + 1}:reviser`);
  }
  const judged = await measure(async () => {
    if (args.select) {
      const decision = selectionSchema.parse(await args.select(Object.freeze([...candidates])));
      const candidate = candidates.find(candidate => candidate.iteration === decision.selected_iteration);
      if (!candidate) throw new Error("Judge selected a nonexistent snapshot");
      if (!isAdmissibleSnapshot(candidate)) throw new Error("Judge selected an inadmissible snapshot");
      return { final: structuredClone(candidate.draft), ...decision, assessment: candidate.assessment };
    }
    if (!args.judge) throw new Error("A snapshot selector or legacy judge is required");
    return { final: await args.judge(structuredClone(draft)), selected_iteration: selectedIteration,
      reason: "Current latest-version policy", assessment: candidates.at(-1)!.assessment };
  });
  const { final, selected_iteration, reason, assessment } = judged.value;
  await args.run.recordAgentEvent({ event_type: "judgment", selected_iteration,
    reason, latency_ms: judged.latency_ms,
    token_usage: judged.token_usage, cost_usd: judged.cost_usd });
  trace.push("judge");
  return { final, selected_iteration, selected_assessment: assessment, exchanges: max, trace };
}

export async function stubAgenticLlm<T>(complete: JsonCompletion, purpose: string): Promise<T | null> {
  try {
    const { raw } = await complete({
      system: "Return JSON only.",
      user: purpose,
      purpose,
    });
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
