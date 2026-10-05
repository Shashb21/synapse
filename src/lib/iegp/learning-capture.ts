import { recordDecisionExample, type DecisionOutcome } from "@/modules/kernel/decision-examples";
import type { GapSuggestion } from "./types";

/**
 * Turns people's decisions on AI output into learning examples (KAN-78). Each
 * helper keeps the case compact — what the AI saw, what it proposed, what the
 * person did — and is best-effort: it never throws into the action it observes.
 */

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
export function captureGapSuggestionDecision(args: {
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
      workspace_id: args.workspace_id,
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
export function captureProposalDecision(args: {
  proposal: { id: string; name: string; type: string; evidence_question: string; rationale: string };
  gap: GapText | null;
  decision: "accept" | "reject";
  /** The idea as accepted, when the person changed it first. */
  final?: { name: string; type: string; evidence_question: string; rationale: string } | null;
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
        !same(args.final.rationale, proposal.rationale));
    await recordDecisionExample({
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
      },
      outcome: args.decision === "reject" ? "rejected" : edited ? "edited" : "accepted",
      final: args.decision === "accept" && edited ? args.final ?? null : null,
      rationale: args.rationale,
    });
  });
}

/** A person saving a mapping-table row the S4 model had proposed. */
export function captureMappingRowDecision(args: {
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
export function captureBandDecision(args: {
  gap: GapText & { id: string };
  suggested_band: string;
  suggested_rationale?: string | null;
  band: string;
  rationale: string;
  workspace_id?: string;
}) {
  return safely(async () => {
    await recordDecisionExample({
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
