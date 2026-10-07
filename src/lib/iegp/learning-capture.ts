import { recordDecisionExample, type DecisionExampleDraft, type DecisionOutcome } from "@/modules/kernel/decision-examples";
import type { GapSuggestion } from "./types";

/**
 * Turns people's decisions on AI output into learning examples (KAN-78). Each
 * helper keeps the case compact — what the AI saw, what it proposed, what the
 * person did — and is best-effort: it never throws into the action it observes.
 */

/** Explicit originating metadata; missing history is retained as missing. */
type Origin = Pick<DecisionExampleDraft, "run_id" | "prompt_version" | "actor" | "replay_input" | "replay_exclusion_reason" | "capture_key">;

/** Copy only supplied lineage; never infer it from the current route. */
function origin(args: Origin): Origin {
  return { run_id: args.run_id, prompt_version: args.prompt_version, actor: args.actor, replay_input: args.replay_input, replay_exclusion_reason: args.replay_exclusion_reason, capture_key: args.capture_key };
}

type GapText = { name: string; statement: string };

const same = (a: string | undefined | null, b: string | undefined | null) =>
  (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

async function safely(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    console.error("[learning] capture failed", error);
  }
}

/** Merge, split or reject on an S2 overlap suggestion (KAN-75). */
export function captureGapSuggestionDecision(args: Origin & {
  suggestion: GapSuggestion;
  gap: GapText | null;
  decision: "merge" | "split" | "reject";
  /** The wording the person kept, when they could edit it. */
  name?: string;
  statement?: string;
  rationale: string;
  workspace_id?: string;
}) {
  return safely(async () => {
    const { suggestion } = args;
    const proposed =
      args.decision === "merge"
        ? { name: suggestion.merged_name, statement: suggestion.merged_statement }
        : args.decision === "split"
          ? { name: suggestion.split_name, statement: suggestion.split_statement }
          : null;
    const finalName = args.name?.trim() || proposed?.name;
    const finalStatement = args.statement?.trim() || proposed?.statement;
    const edited = proposed !== null && (!same(finalName, proposed.name) || !same(finalStatement, proposed.statement));
    const outcome: DecisionOutcome = args.decision === "reject" ? "rejected" : edited ? "edited" : "accepted";
    await recordDecisionExample({
      ...origin(args),
      workspace_id: args.workspace_id,
      run_id: args.run_id ?? suggestion.run_id,
      capture_key: args.capture_key ?? `gap-suggestion:${suggestion.id}`,
      stage: "S2",
      kind: "gap_suggestion",
      subject_id: suggestion.id,
      ai_input: {
        existing_gap: args.gap,
        candidate: { name: suggestion.name, statement: suggestion.statement },
      },
      ai_output: {
        verdict: "overlaps",
        shared_part: suggestion.shared_part,
        new_part: suggestion.new_part,
        merged: { name: suggestion.merged_name, statement: suggestion.merged_statement },
        split: { name: suggestion.split_name, statement: suggestion.split_statement },
      },
      outcome,
      final:
        args.decision === "reject"
          ? { decision: "reject" }
          : { decision: args.decision, name: finalName, statement: finalStatement },
      rationale: args.rationale,
    });
  });
}

/** Accept, edit-and-accept or reject on an S9 idea the model wrote. */
export function captureProposalDecision(args: Origin & {
  proposal: { id: string; name: string; type: string; evidence_question: string; rationale: string; design?: unknown };
  gap: GapText | null;
  decision: "accept" | "reject";
  /** The idea as accepted, when the person changed it first. */
  final?: { name: string; type: string; evidence_question: string; rationale: string; design?: unknown } | null;
  rationale: string;
  workspace_id?: string;
}) {
  return safely(async () => {
    const { proposal } = args;
    const edited =
      !!args.final &&
      (!same(args.final.name, proposal.name) ||
        !same(args.final.type, proposal.type) ||
        !same(args.final.evidence_question, proposal.evidence_question) ||
        !same(args.final.rationale, proposal.rationale) ||
        JSON.stringify(args.final.design ?? null) !== JSON.stringify(proposal.design ?? null));
    await recordDecisionExample({
      ...origin(args),
      workspace_id: args.workspace_id,
      stage: "S9",
      kind: "s9_proposal",
      subject_id: proposal.id,
      ai_input: { gap: args.gap },
      ai_output: {
        name: proposal.name,
        type: proposal.type,
        evidence_question: proposal.evidence_question,
        rationale: proposal.rationale,
        design: proposal.design ?? null,
      },
      outcome: args.decision === "reject" ? "rejected" : edited ? "edited" : "accepted",
      final: args.decision === "accept" && edited ? args.final ?? null : null,
      rationale: args.rationale,
    });
  });
}

/** A person saving a mapping-table row the S4 model had proposed. */
export function captureMappingRowDecision(args: Origin & {
  gap: GapText & { id: string };
  ai: { mapping_status: string; tactic_ids: string[] };
  saved: { mapping_status: string; tactic_ids: string[] };
  rationale: string;
  workspace_id?: string;
}) {
  return safely(async () => {
    const sort = (ids: string[]) => [...new Set(ids)].sort();
    const unchanged =
      args.ai.mapping_status === args.saved.mapping_status &&
      sort(args.ai.tactic_ids).join(",") === sort(args.saved.tactic_ids).join(",");
    await recordDecisionExample({
      ...origin(args),
      workspace_id: args.workspace_id,
      stage: "S4",
      kind: "s4_mapping",
      subject_id: args.gap.id,
      ai_input: { gap: { name: args.gap.name, statement: args.gap.statement } },
      ai_output: { mapping_status: args.ai.mapping_status, tactic_ids: sort(args.ai.tactic_ids) },
      outcome: unchanged ? "accepted" : "edited",
      final: unchanged ? null : { mapping_status: args.saved.mapping_status, tactic_ids: sort(args.saved.tactic_ids) },
      rationale: args.rationale,
    });
  });
}

/** A person validating a priority band the S8 model had suggested. */
export function captureBandDecision(args: Origin & {
  gap: GapText & { id: string };
  suggested_band: string;
  suggested_rationale?: string | null;
  band: string;
  rationale: string;
  workspace_id?: string;
}) {
  return safely(async () => {
    await recordDecisionExample({
      ...origin(args),
      require_originating_run: true,
      workspace_id: args.workspace_id,
      stage: "S8",
      kind: "s8_band",
      subject_id: args.gap.id,
      ai_input: { gap: { name: args.gap.name, statement: args.gap.statement } },
      ai_output: { band: args.suggested_band, rationale: args.suggested_rationale ?? null },
      outcome: args.band === args.suggested_band ? "accepted" : "edited",
      final: args.band === args.suggested_band ? null : { band: args.band },
      rationale: args.rationale,
    });
  });
}

/** Capture a residual decision only when its originating AI run can be verified. */
export function captureResidualDecision(args: Origin & {
  parent_gap_id: string;
  proposed: string;
  final: string | null;
  decision: "accept" | "edit" | "reject";
  rationale: string;
  workspace_id?: string;
}) {
  return safely(() => recordDecisionExample({
    ...origin(args), require_originating_run: true, workspace_id: args.workspace_id, stage: "S6", kind: "residual_split",
    subject_id: args.parent_gap_id, ai_input: { parent_gap_id: args.parent_gap_id },
    ai_output: { statement: args.proposed },
    outcome: args.decision === "reject" ? "rejected" : args.decision === "edit" || !same(args.proposed, args.final) ? "edited" : "accepted",
    final: args.final == null ? null : { statement: args.final }, rationale: args.rationale,
  }));
}
