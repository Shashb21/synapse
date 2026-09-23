import { z } from "zod";
import { agenticModule } from "../_factory";
import { runShallowAgenticCycle } from "../../kernel/agentic";
import { completeJson } from "../../kernel/routing";
import { provenanceSpanSchema } from "../../store/quote-validator";
import { newId } from "@/modules/kernel/ids";
import type { AccuracyModuleContext } from "../../kernel/contracts";
import { NEED_PROPOSER_SYSTEM, needProposerUser } from "./prompts";
import { scorePackRecall } from "../../eval/reference-gold";

export const needGapSchema = z.object({
  id: z.string(),
  statement: z.string().min(1),
  external_id: z.string().nullable(),
  provenance: z.array(provenanceSpanSchema).min(1),
});

export type NeedGap = z.infer<typeof needGapSchema>;

export const needExtractOutputSchema = z.object({
  workspace_id: z.string(),
  source_file_id: z.string(),
  gaps: z.array(needGapSchema),
});

export type NeedExtractOutput = z.infer<typeof needExtractOutputSchema>;

const proposerGapSchema = z.object({
  statement: z.string(),
  external_id: z.string().nullable().optional(),
  provenance: z.array(provenanceSpanSchema).optional(),
});

type NeedDraft = {
  gaps: z.infer<typeof proposerGapSchema>[];
};

function critiqueDraft(draft: NeedDraft, source_file_id: string): { score: number; issues: string[] } {
  const issues: string[] = [];
  if (draft.gaps.length === 0) issues.push("no_gaps_proposed");
  const seen = new Set<string>();
  for (const [index, gap] of draft.gaps.entries()) {
    const subject = gap.external_id || gap.statement?.slice(0, 40) || `gap_${index}`;
    if (!gap.statement?.trim()) issues.push(`${subject}:missing_statement`);
    if (!gap.provenance?.length) {
      issues.push(`${subject}:no_quote`);
    } else {
      for (const span of gap.provenance) {
        if (span.source_file_id !== source_file_id) issues.push(`${subject}:source_file_mismatch`);
        if (!span.quote?.trim()) issues.push(`${subject}:empty_quote`);
      }
    }
    const key = (gap.external_id || gap.statement).trim().toLowerCase();
    if (key) {
      if (seen.has(key)) issues.push(`${subject}:duplicate`);
      seen.add(key);
    }
  }
  const score = draft.gaps.length === 0 ? 0 : Math.max(0, 1 - issues.length * 0.15);
  return { score, issues };
}

function normalizeDraft(raw: unknown, source_file_id: string): NeedDraft {
  const parsed = z.object({ gaps: z.array(proposerGapSchema).default([]) }).safeParse(raw);
  if (!parsed.success) return { gaps: [] };
  return {
    gaps: parsed.data.gaps.map((g) => ({
      ...g,
      external_id: g.external_id ?? null,
      provenance: (g.provenance ?? []).map((p) => ({
        ...p,
        source_file_id: p.source_file_id || source_file_id,
      })),
    })),
  };
}

function judgeDraft(draft: NeedDraft): NeedGap[] {
  const out: NeedGap[] = [];
  for (const gap of draft.gaps) {
    const parsed = needGapSchema.safeParse({
      id: newId("gap"),
      statement: gap.statement.trim(),
      external_id: gap.external_id?.trim() || null,
      provenance: gap.provenance ?? [],
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

async function proposeNeeds(
  ctx: AccuracyModuleContext,
  input: { workspace_id: string; source_file_id: string; block_ids: string[] },
  round: number,
  prior: NeedDraft | null,
  critiques: string[],
): Promise<NeedDraft> {
  if (process.env.SYNAPSE_TEST_STUB_LLM === "1") {
    return { gaps: [] };
  }
  const raw = await completeJson(ctx.complete, {
    system: NEED_PROPOSER_SYSTEM,
    user: needProposerUser({
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      block_ids: input.block_ids,
      blocks: [],
      critiques: round === 0 ? [] : critiques,
    }),
    purpose: `need_extract:proposer:r${round}`,
  });
  if (round > 0 && prior && (!raw || (raw as { gaps?: unknown[] }).gaps?.length === 0)) {
    return prior;
  }
  return normalizeDraft(raw, input.source_file_id);
}

/** Recall of extracted external_ids against reference pack must_find gap IDs. */
export function scoreGapIdRecall(args: {
  packId: string;
  extractedExternalIds: (string | null | undefined)[];
}): { found: string[]; missing: string[]; recall: number } {
  const slice = scorePackRecall(args.packId, { gap_ids: args.extractedExternalIds }).gap_ids;
  return { found: slice.found, missing: slice.missing, recall: slice.recall };
}

export const needExtractModule = agenticModule({
  id: "need-extract.agent-v1",
  call_kind: "need_extract",
  title: "Need extract",
  summary: "Evidence gaps from parse blocks (1× PCJ default).",
  inputSchema: z.object({
    workspace_id: z.string(),
    source_file_id: z.string(),
    block_ids: z.array(z.string()),
  }),
  outputSchema: needExtractOutputSchema,
  run: async (input, ctx) => {
    const stub = process.env.SYNAPSE_TEST_STUB_LLM === "1";

    const cycle = await runShallowAgenticCycle<NeedDraft>({
      proposer: (round, prior, critiques) => proposeNeeds(ctx, input, round, prior, critiques),
      critic: async (draft) => {
        if (stub) return { score: 1, issues: [] };
        return critiqueDraft(draft, input.source_file_id);
      },
      judge: async (draft) => draft,
    });

    ctx.run.note("agentic:trace", cycle.trace);
    const gaps = stub ? [] : judgeDraft(cycle.final);
    return {
      output: {
        workspace_id: input.workspace_id,
        source_file_id: input.source_file_id,
        gaps,
      },
      summary: stub
        ? "Need extract (SYNAPSE_TEST_STUB_LLM — empty gaps)"
        : `Need extract — ${gaps.length} gap(s)`,
    };
  },
});
