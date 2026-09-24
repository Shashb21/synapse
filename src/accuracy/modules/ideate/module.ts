import { z } from "zod";
import { agenticModule } from "../_factory";
import { runShallowAgenticCycle } from "../../kernel/agentic";
import { completeJson } from "../../kernel/routing";
import { isTestStub } from "@/modules/kernel/llm";
import { NoRouteError } from "@/modules/llm/provider";
import type { AccuracyModuleContext } from "../../kernel/contracts";
import {
  gapsEligibleForIdeation,
  ideatedTacticExpectsNoSourceQuote,
  looksLikeInventoryIdentifier,
  type GapRecord,
} from "../../domain/iegp-semantics";
import { TACTIC_TYPES, type TacticType } from "@/lib/iegp/enums";
import { IDEATE_PROPOSER_SYSTEM, ideateProposerUser } from "./prompts";

const tacticTypeSchema = z.enum(TACTIC_TYPES);

export const ideationProposalSchema = z.object({
  gap_id: z.string(),
  name: z.string().min(8).max(280),
  type: tacticTypeSchema,
  origin: z.literal("ideated"),
  status: z.literal("proposed"),
  design_summary: z.string().min(3),
  /** Ideated tactics are created net-new — not expected to match reference inventory extract. */
  not_from_reference: z.literal(true),
});

export type IdeationProposal = z.infer<typeof ideationProposalSchema>;

export const ideateInputSchema = z.object({
  workspace_id: z.string(),
  gaps: z.array(
    z.object({
      id: z.string(),
      statement: z.string().default(""),
      status: z.enum(["open", "partial", "addressed"]),
      priority_band: z.enum(["high", "medium", "low"]).nullable(),
      validated: z.boolean().optional(),
    }),
  ),
  existing_tactic_names: z.array(z.string()),
  hints: z.string().optional(),
  per_gap: z.number().int().min(1).max(3).default(1),
});

export type IdeateInput = z.infer<typeof ideateInputSchema>;

export const ideateOutputSchema = z.object({
  mode: z.enum(["llm", "stub"]),
  eligible_gap_ids: z.array(z.string()),
  proposals: z.array(ideationProposalSchema),
});

export type IdeateOutput = z.infer<typeof ideateOutputSchema>;

const proposerRowSchema = z.object({
  gap_id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  origin: z.string().optional(),
  status: z.string().optional(),
  design_summary: z.string().optional(),
  rationale: z.string().optional(),
  evidence_question: z.string().optional(),
  not_from_reference: z.boolean().optional(),
  provenance: z.unknown().optional(),
});

type IdeationDraft = { proposals: z.infer<typeof proposerRowSchema>[] };

function routeAllowsLlm(route: AccuracyModuleContext["route"]): boolean {
  return route.connected && (route.auth === "oauth" || route.auth === "api_key");
}

function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The model must name a real tactic type; nothing is defaulted on its behalf. */
function tacticTypeOf(raw: string | undefined): TacticType | null {
  return TACTIC_TYPES.includes(raw as TacticType) ? (raw as TacticType) : null;
}

function normalizeDraft(raw: unknown): IdeationDraft {
  const parsed = z
    .object({
      proposals: z.array(proposerRowSchema).optional(),
      tactics: z.array(proposerRowSchema).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { proposals: [] };
  const rows = parsed.data.proposals ?? parsed.data.tactics ?? [];
  return {
    proposals: rows.map((row) => ({
      ...row,
      origin: "ideated",
      status: "proposed",
      not_from_reference: true,
    })),
  };
}

export function critiqueIdeationDraft(
  draft: IdeationDraft,
  args: { eligibleIds: Set<string>; existingNames: Set<string> },
): { score: number; issues: string[] } {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, row] of draft.proposals.entries()) {
    const subject = row.name?.trim() || row.gap_id || `proposal_${index}`;
    if (!args.eligibleIds.has(row.gap_id)) issues.push(`${subject}:ineligible_gap`);
    if (row.origin && row.origin !== "ideated") issues.push(`${subject}:wrong_origin`);
    if (row.status && row.status !== "proposed") issues.push(`${subject}:wrong_status`);
    if (!row.name?.trim() || row.name.trim().length < 8) issues.push(`${subject}:missing_name`);
    if (!tacticTypeOf(row.type)) issues.push(`${subject}:invalid_type`);
    const summary = (row.design_summary || row.rationale || "").trim();
    if (summary.length < 3) issues.push(`${subject}:missing_design`);
    if (looksLikeInventoryIdentifier(row.name ?? "") || looksLikeInventoryIdentifier(row.gap_id)) {
      issues.push(`${subject}:looks_like_inventory_id`);
    }
    if (row.provenance != null) issues.push(`${subject}:source_quote_claimed`);
    const key = nameKey(row.name ?? "");
    if (key && args.existingNames.has(key)) issues.push(`${subject}:already_in_library`);
    if (key) {
      if (seen.has(key)) issues.push(`${subject}:duplicate`);
      seen.add(key);
    }
  }
  const score = draft.proposals.length === 0 ? 0 : Math.max(0, 1 - issues.length * 0.15);
  return { score, issues };
}

/**
 * Lock LLM (or stub) rows onto product semantics: ideated + proposed, high-open gaps only,
 * no source quotes, no inventory identifiers, no library duplicates.
 */
export function lockIdeationProposals(
  draft: IdeationDraft,
  args: { eligibleIds: Set<string>; existingNames: Set<string>; perGap: number },
): IdeationProposal[] {
  const perGap = new Map<string, number>();
  const out: IdeationProposal[] = [];
  for (const row of draft.proposals) {
    if (!args.eligibleIds.has(row.gap_id)) continue;
    const name = row.name.trim();
    if (looksLikeInventoryIdentifier(name)) continue;
    const key = nameKey(name);
    if (key && args.existingNames.has(key)) continue;
    const used = perGap.get(row.gap_id) ?? 0;
    if (used >= args.perGap) continue;
    const type = tacticTypeOf(row.type);
    if (!type) continue;
    const parsed = ideationProposalSchema.safeParse({
      gap_id: row.gap_id,
      name,
      type,
      origin: "ideated",
      status: "proposed",
      design_summary: (row.design_summary || row.rationale || row.evidence_question || "").trim(),
      not_from_reference: true,
    });
    if (!parsed.success) continue;
    if (!ideatedTacticExpectsNoSourceQuote(parsed.data.origin)) continue;
    perGap.set(row.gap_id, used + 1);
    out.push(parsed.data);
    if (key) args.existingNames.add(key);
  }
  return out;
}

async function proposeIdeation(
  ctx: AccuracyModuleContext,
  input: IdeateInput,
  eligible: GapRecord[],
  round: number,
  prior: IdeationDraft | null,
  critiques: string[],
): Promise<IdeationDraft> {
  if (isTestStub() || eligible.length === 0) {
    return { proposals: [] };
  }
  const statements = new Map(input.gaps.map((g) => [g.id, g.statement]));
  const raw = await completeJson(ctx.complete, {
    system: IDEATE_PROPOSER_SYSTEM,
    user: ideateProposerUser({
      workspace_id: input.workspace_id,
      gaps: eligible.map((g) => ({ id: g.id, statement: statements.get(g.id) ?? "" })),
      existing_tactic_names: input.existing_tactic_names,
      per_gap: input.per_gap ?? 1,
      hints: input.hints,
      critiques: round === 0 ? [] : critiques,
    }),
    purpose: `ideate:proposer:r${round}`,
  });
  if (round > 0 && prior && (!raw || typeof raw !== "object")) {
    return prior;
  }
  const draft = normalizeDraft(raw);
  if (round > 0 && prior && draft.proposals.length === 0) return prior;
  return draft;
}

export const ideateModule = agenticModule({
  id: "ideate.agent-v1",
  call_kind: "ideate",
  title: "Ideate",
  summary:
    "Create net-new proposed tactics for validated HIGH-priority open gaps only (not inventory extract).",
  inputSchema: ideateInputSchema,
  outputSchema: ideateOutputSchema,
  run: async (input, ctx) => {
    const eligible = gapsEligibleForIdeation(input.gaps);
    const eligibleIds = new Set(eligible.map((g) => g.id));
    const existingNames = new Set(input.existing_tactic_names.map(nameKey).filter(Boolean));
    ctx.run.note("ideate:eligible_high_open", [...eligibleIds]);

    if (eligible.length === 0) {
      return {
        output: { mode: "stub", eligible_gap_ids: [], proposals: [] },
        summary: "Ideation skipped — no high-priority open gaps",
      };
    }
    if (isTestStub()) {
      return {
        output: { mode: "stub", eligible_gap_ids: [...eligibleIds], proposals: [] },
        summary: "Ideation stub (SYNAPSE_TEST_STUB_LLM — empty proposals)",
      };
    }
    // Ideation is judgement: without a model there is nothing to fall back to.
    if (!routeAllowsLlm(ctx.route)) {
      throw new NoRouteError(
        ctx.route.reason && ctx.route.reason !== "mechanical"
          ? ctx.route.reason
          : "Ideation needs a connected LLM. Connect Grok or Claude in /control and run it again.",
      );
    }

    const cycle = await runShallowAgenticCycle<IdeationDraft>({
      proposer: (round, prior, critiques) =>
        proposeIdeation(ctx, input, eligible, round, prior, critiques),
      critic: async (draft) => critiqueIdeationDraft(draft, { eligibleIds, existingNames }),
      judge: async (draft) => draft,
    });

    ctx.run.note("agentic:trace", cycle.trace);
    const perGap = input.per_gap ?? 1;
    const proposals = lockIdeationProposals(cycle.final, {
      eligibleIds,
      existingNames: new Set(existingNames),
      perGap,
    });

    return {
      output: { mode: "llm", eligible_gap_ids: [...eligibleIds], proposals },
      summary: `Ideation — ${proposals.length} proposed tactic(s) for ${eligibleIds.size} high-priority open gap(s)`,
    };
  },
});
