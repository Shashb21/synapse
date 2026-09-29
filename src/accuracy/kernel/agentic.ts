import type { JsonCompletion, RunHandle, TokenUsage } from "../kernel/contracts";
import type { CriticIssue, ProductionSignals } from "./agent-events";
import { validateProvenance, type ProvenanceSpan } from "../store/quote-validator";

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
  critic: (draft: T) => Promise<{ score: number; issues: CriticIssue[] }>;
  judge: (draft: T) => Promise<T>;
}): Promise<AgenticExchangeResult<T>> {
  const max = args.maxExchanges ?? 1;
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
      evaluation_context: "production", signals, latency_ms: metering.latency_ms,
      token_usage: metering.token_usage, cost_usd: metering.cost_usd });
  };
  const initial = await measure(() => args.proposer(0, null, []));
  let draft = initial.value;
  await snapshot(draft, 0, initial);
  trace.push("round0:proposer");
  let selectedIteration = 0;
  for (let exchange = 0; exchange < max; exchange++) {
    const critiqued = await measure(() => args.critic(draft));
    const critique = critiqued.value;
    await args.run.recordAgentEvent({ event_type: "critique", iteration: exchange,
      score: critique.score, issues: critique.issues, latency_ms: critiqued.latency_ms,
      token_usage: critiqued.token_usage, cost_usd: critiqued.cost_usd });
    trace.push(`round${exchange + 1}:critic`);
    if (critique.issues.length === 0 && critique.score >= 0.85) break;
    const revised = await measure(() => args.proposer(exchange + 1, draft, critique.issues.map((issue) => issue.claim)));
    draft = revised.value;
    selectedIteration = exchange + 1;
    await snapshot(draft, selectedIteration, revised);
    trace.push(`round${exchange + 1}:reviser`);
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
