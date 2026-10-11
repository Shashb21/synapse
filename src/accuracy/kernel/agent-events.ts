/** Append-only, workspace-scoped persistence for agent loop observations. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { newId, nowIso } from "@/modules/kernel/ids";
import type { TokenUsage } from "./contracts";
import type { SnapshotCompletenessAssessment } from "@/accuracy/modules/completeness-audit/snapshot-inspector";

const nonnegativeInt = z.number().int().nonnegative();
const nonnegativeNumber = z.number().finite().nonnegative();
const tokenUsageSchema: z.ZodType<TokenUsage> = z.strictObject({
  prompt_tokens: nonnegativeInt,
  completion_tokens: nonnegativeInt,
  total_tokens: nonnegativeInt,
});
const sourceRefSchema = z.strictObject({
  source_file_id: z.string().min(1),
  block_id: z.string().min(1),
});
const criticIssueSchema = z.strictObject({
  issue_id: z.string().min(1),
  category: z.string().min(1),
  code: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  claim: z.string().min(1),
  source_ref: sourceRefSchema.optional(),
  suggested_action: z.string().min(1),
  content_fingerprint: z.string().min(1).optional(),
});
export const structuralResolutionSchema = z.strictObject({
  issue_key: z.string().min(1),
  issue: criticIssueSchema,
  outcome: z.enum(["unresolved", "partly_resolved", "resolved", "invalid"]),
  reason: z.string().trim().min(1),
  evidence: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("deterministic_rerun"), check_id: z.string().min(1) }),
    z.strictObject({ kind: z.literal("validated_assessment"), explanation: z.string().trim().min(1) }),
  ]).nullable(),
});
const structuralFateSchema = z.strictObject({
  status: z.enum(["assessed", "unavailable"]),
  check: z.strictObject({ id: z.string().min(1), exhaustive: z.literal(true) }).nullable(),
  prior_issue_resolutions: z.array(structuralResolutionSchema),
});
const productionSignalsSchema = z.strictObject({
  quote_validity: z.strictObject({
    valid_count: nonnegativeInt,
    invalid_count: nonnegativeInt,
    unchecked_count: nonnegativeInt,
  }),
  invariant_failures: z.array(z.string().min(1)),
  completeness: z.literal("not_checked"),
});
const omissionSchema = z.strictObject({
  issue_id: z.string().min(1),
  item_kind: z.enum(["gap", "tactic"]),
  summary: z.string().min(1),
  source_ref: sourceRefSchema,
  evidence_quote: z.string().min(1),
  basis: z.enum(["explicit", "inferred"]),
  importance: z.enum(["important", "advisory"]),
  reason: z.string().min(1),
  suggested_action: z.string().min(1),
});
const resolutionSchema = z.strictObject({
  issue_id: z.string().min(1),
  outcome: z.enum(["unresolved", "partly_resolved", "resolved", "invalid"]),
  reason: z.string().min(1),
  matched_item_ref: z.string().min(1).optional(),
});
const completenessSchema: z.ZodType<SnapshotCompletenessAssessment> = z.strictObject({
  risk_level: z.enum(["not_applicable", "none_detected", "advisory", "important", "check_failed"]),
  checked_block_ids: z.array(z.string().min(1)),
  unchecked_block_ids: z.array(z.string().min(1)),
  suspected_omissions: z.array(omissionSchema),
  prior_issue_resolutions: z.array(resolutionSchema),
});
const metering = {
  latency_ms: nonnegativeNumber,
  token_usage: tokenUsageSchema,
  cost_usd: nonnegativeNumber,
};
const snapshotSchema = z.strictObject({
  event_type: z.literal("snapshot"),
  iteration: nonnegativeInt,
  output: z.unknown().refine((value) => value !== undefined, "Snapshot output is required"),
  evaluation_context: z.enum(["production", "experiment"]),
  signals: productionSignalsSchema,
  ...metering,
});
const critiqueSchema = z.strictObject({
  event_type: z.literal("critique"),
  iteration: nonnegativeInt,
  score: z.number().finite().min(0).max(1).nullable(),
  issues: z.array(criticIssueSchema),
  completeness: completenessSchema,
  structural_fate: structuralFateSchema.optional(),
  ...metering,
});
const judgmentSchema = z.strictObject({
  event_type: z.literal("judgment"),
  selected_iteration: nonnegativeInt,
  reason: z.string().min(1),
  ...metering,
});
const agentEventSchema = z.discriminatedUnion("event_type", [
  snapshotSchema, critiqueSchema, judgmentSchema,
]);

/** Supply an explicit historical state only for stored critiques predating completeness. */
function parseStoredEvent(payload: unknown): AgentEvent {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)
    && "event_type" in payload && payload.event_type === "critique" && !("structural_fate" in payload)) {
    payload = { ...payload, structural_fate: { status: "unavailable", check: null, prior_issue_resolutions: [] } };
  }
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)
    && "event_type" in payload && payload.event_type === "critique" && !("completeness" in payload)) {
    return agentEventSchema.parse({ ...payload, completeness: {
      risk_level: "not_applicable", checked_block_ids: [], unchecked_block_ids: [],
      suspected_omissions: [], prior_issue_resolutions: [],
    } });
  }
  return agentEventSchema.parse(payload);
}

export type CriticIssue = z.infer<typeof criticIssueSchema>;
export type StructuralIssueResolution = z.infer<typeof structuralResolutionSchema>;
export type StructuralFate = z.infer<typeof structuralFateSchema>;
export type ProductionSignals = z.infer<typeof productionSignalsSchema>;
export type AgentSnapshotEvent = z.infer<typeof snapshotSchema>;
export type AgentCritiqueEvent = z.infer<typeof critiqueSchema>;
export type AgentJudgmentEvent = z.infer<typeof judgmentSchema>;
export type AgentEvent = AgentSnapshotEvent | AgentCritiqueEvent | AgentJudgmentEvent;
export type AgentEventRecord = {
  id: string;
  run_id: string;
  workspace_id: string;
  event_type: AgentEvent["event_type"];
  iteration: number;
  event: AgentEvent;
  recorded_at: string;
};
export type AgentProgression = {
  run_id: string;
  workspace_id: string;
  events: AgentEventRecord[];
};

/** Check tenant ownership through the parent module run. */
async function matchingRun(run_id: string, workspace_id: string): Promise<boolean> {
  const rows = await accuracyDb()
    .select({ id: t.accuracyModuleRuns.id })
    .from(t.accuracyModuleRuns)
    .where(and(eq(t.accuracyModuleRuns.id, run_id), eq(t.accuracyModuleRuns.workspace_id, workspace_id)))
    .limit(1);
  return rows.length === 1;
}

/**
 * Persist one validated observation without replacing prior versions.
 *
 * @param args - Parent run, workspace, and production event.
 * @throws Error when the run is outside the workspace; ZodError for invalid payloads;
 *   database uniqueness error for a duplicate type and iteration.
 */
export async function appendAgentEvent(args: {
  run_id: string;
  workspace_id: string;
  event: AgentEvent;
}): Promise<void> {
  const event = agentEventSchema.parse(args.event);
  await ensureAccuracySchema();
  if (!(await matchingRun(args.run_id, args.workspace_id))) {
    throw new Error(`Unknown accuracy run in workspace: ${args.run_id}`);
  }
  await accuracyDb().insert(t.accuracyAgentEvents).values({
    id: newId("aevt"),
    run_id: args.run_id,
    workspace_id: args.workspace_id,
    event_type: event.event_type,
    iteration: event.event_type === "judgment" ? -1 : event.iteration,
    payload: event,
    recorded_at: nowIso(),
  });
}

/**
 * Read all observations for one run, ordered as snapshots, critiques, then judgment.
 *
 * @param args - Parent run and required workspace scope.
 * @returns The progression, or null when the run does not belong to the workspace.
 */
export async function readAgentProgression(args: {
  run_id: string;
  workspace_id: string;
}): Promise<AgentProgression | null> {
  await ensureAccuracySchema();
  if (!(await matchingRun(args.run_id, args.workspace_id))) return null;
  const rows = await accuracyDb()
    .select()
    .from(t.accuracyAgentEvents)
    .where(and(eq(t.accuracyAgentEvents.run_id, args.run_id), eq(t.accuracyAgentEvents.workspace_id, args.workspace_id)));
  const events = rows.map((row): AgentEventRecord => {
    if (row.iteration === null) throw new Error(`Agent event has no iteration: ${row.id}`);
    return {
      id: row.id,
      run_id: row.run_id,
      workspace_id: row.workspace_id,
      event_type: row.event_type as AgentEvent["event_type"],
      iteration: row.iteration,
      event: parseStoredEvent(row.payload),
      recorded_at: row.recorded_at,
    };
  });
  events.sort((a, b) => {
    const iterationA = a.event_type === "judgment" ? Number.MAX_SAFE_INTEGER : a.iteration;
    const iterationB = b.event_type === "judgment" ? Number.MAX_SAFE_INTEGER : b.iteration;
    if (iterationA !== iterationB) return iterationA - iterationB;
    return (a.event_type === "snapshot" ? 0 : 1) - (b.event_type === "snapshot" ? 0 : 1);
  });
  return { run_id: args.run_id, workspace_id: args.workspace_id, events };
}
