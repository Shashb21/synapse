import type { JsonCompletion, RunHandle, TokenUsage } from "../kernel/contracts";
import { validateExperimentCycleControl } from "./contracts";
import type { CriticIssue, ProductionSignals } from "./agent-events";
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

export type AgenticExchangeResult<T> = {
  final: T;
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
  critic: (draft: T) => Promise<{ score: number; issues: CriticIssue[]; observationIssues?: CriticIssue[] }>;
  onCompleteness?: (draft: T, prior_open_issues: SuspectedOmission[]) => Promise<SnapshotCompletenessAssessment>;
  judge: (draft: T) => Promise<T>;
}): Promise<AgenticExchangeResult<T>> {
  const control = validateExperimentCycleControl(args.run.experiment_cycle_control, args.run.evaluation_context ?? "production");
  const max = control?.critic_revision_passes ?? args.maxExchanges ?? 1;
  if (!Number.isInteger(max) || max < 0) throw new RangeError("maxExchanges must be a nonnegative integer");
  const trace: string[] = [];
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
    const signals = await args.onSnapshot(draft, iteration);
    await args.run.recordAgentEvent({ event_type: "snapshot", iteration, output: draft,
      evaluation_context: args.run.evaluation_context ?? "production", signals, latency_ms: metering.latency_ms,
      token_usage: metering.token_usage, cost_usd: metering.cost_usd });
  };
  const initial = await measure(() => args.proposer(0, null, []));
  let draft = initial.value;
  await snapshot(draft, 0, initial);
  trace.push("round0:proposer");
  let selectedIteration = 0;
  let priorOpenIssues: SuspectedOmission[] = [];
  for (let iteration = 0; iteration <= max; iteration++) {
    // Every produced version receives a structural and completeness assessment.
    const assessed = await measure(async () => {
      let structural: Awaited<ReturnType<typeof args.critic>> | null = null;
      let structuralError: unknown;
      let structuralFailed = false;
      try {
        structural = await args.critic(draft);
      } catch (error) {
        structuralError = error;
        structuralFailed = true;
      }
      let completeness = notApplicable;
      if (args.onCompleteness) {
        try {
          completeness = await args.onCompleteness(draft, [...priorOpenIssues]);
        } catch {
          completeness = failedAssessment(priorOpenIssues);
        }
      }
      return { structural, completeness, structuralError, structuralFailed };
    });
    const { structural, completeness, structuralError, structuralFailed } = assessed.value;
    const importantIssues = completeness.suspected_omissions
      .filter((issue) => issue.importance === "important").map(omissionIssue);
    await args.run.recordAgentEvent({ event_type: "critique", iteration,
      score: structural?.score ?? null,
      issues: [...(structural?.issues ?? []), ...(structural?.observationIssues ?? []), ...importantIssues],
      completeness, latency_ms: assessed.latency_ms,
      token_usage: assessed.token_usage, cost_usd: assessed.cost_usd });
    if (structuralFailed) throw structuralError;
    priorOpenIssues = completeness.suspected_omissions;
    if (structural) trace.push(`round${iteration + 1}:critic`);
    if (iteration === max || !structural) break;
    if (!control && structural.issues.length === 0 && structural.score >= 0.85 && importantIssues.length === 0) break;
    const feedback = [
      ...structural.issues.map((issue) => issue.claim),
      ...importantIssues.map((issue) => `${issue.claim} Action: ${issue.suggested_action}`),
    ];
    const revised = await measure(() => args.proposer(iteration + 1, draft, feedback));
    draft = revised.value;
    selectedIteration = iteration + 1;
    await snapshot(draft, selectedIteration, revised);
    trace.push(`round${iteration + 1}:reviser`);
  }
  const judged = await measure(() => args.judge(draft));
  const final = judged.value;
  await args.run.recordAgentEvent({ event_type: "judgment", selected_iteration: selectedIteration,
    reason: "Current latest-version policy", latency_ms: judged.latency_ms,
    token_usage: judged.token_usage, cost_usd: judged.cost_usd });
  trace.push("judge");
  return { final, exchanges: max, trace };
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
