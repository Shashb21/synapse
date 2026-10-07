import { z } from "zod";
import { agenticModule } from "../_factory";
import { inspectQuoteSpans, runShallowAgenticCycle } from "../../kernel/agentic";
import type { CriticIssue, ProductionSignals } from "../../kernel/agent-events";
import { completeJson } from "../../kernel/routing";
import { isTestStub } from "@/modules/kernel/llm";
import { provenanceSpanSchema } from "../../store/quote-validator";
import { newId } from "@/modules/kernel/ids";
import type { AccuracyModuleContext } from "../../kernel/contracts";
import { NEED_PROPOSER_SYSTEM, needProposerUser } from "./prompts";
import { readParseBlocks, readParseBlocksByIds } from "../../store/parse-store";
import { claimMetadata, listActiveSourceClaims } from "../../store/claim-store";
import { inspectSnapshotCompleteness, type SnapshotItem } from "../completeness-audit/snapshot-inspector";

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

function critiqueDraft(draft: NeedDraft, source_file_id: string, blocks: { id: string; source_file_id: string; text: string }[]): { score: number; issues: CriticIssue[]; observationIssues: CriticIssue[] } {
  const issues: CriticIssue[] = [];
  const observationIssues: CriticIssue[] = [];
  const add = (claim: string, code: string, source_ref?: CriticIssue["source_ref"]) => {
    issues.push({ issue_id: `need:${issues.length}`, category: "need_extract", code,
      severity: "medium", claim, suggested_action: claim, ...(source_ref ? { source_ref } : {}) });
  };
  if (draft.gaps.length === 0) add("no_gaps_proposed", "no_gaps_proposed");
  const seen = new Set<string>();
  for (const [index, gap] of draft.gaps.entries()) {
    const subject = gap.external_id || gap.statement?.slice(0, 40) || `gap_${index}`;
    if (!gap.statement?.trim()) add(`${subject}:missing_statement`, "missing_statement");
    if (!gap.provenance?.length) {
      add(`${subject}:no_quote`, "no_quote");
    } else {
      for (const span of gap.provenance) {
        const ref = span.source_file_id && span.block_id ? { source_file_id: span.source_file_id, block_id: span.block_id } : undefined;
        if (span.source_file_id !== source_file_id) add(`${subject}:source_file_mismatch`, "source_file_mismatch", ref);
        if (!span.quote?.trim()) add(`${subject}:empty_quote`, "empty_quote", ref);
      }
    }
    const key = (gap.external_id || gap.statement).trim().toLowerCase();
    if (key) {
      if (seen.has(key)) add(`${subject}:duplicate`, "duplicate");
      seen.add(key);
    }
  }
  const checked = inspectQuoteSpans({ spans: draft.gaps.flatMap((gap) => gap.provenance ?? []), blocks });
  for (const finding of checked.findings) {
    observationIssues.push({ issue_id: `need:observed:${observationIssues.length}`,
      category: "quote_validity", code: finding.code, severity: "medium",
      claim: `${finding.span.block_id}:${finding.code}`,
      suggested_action: "Check the quote against its source block",
      source_ref: { source_file_id: finding.span.source_file_id, block_id: finding.span.block_id } });
  }
  const score = draft.gaps.length === 0 ? 0 : Math.max(0, 1 - issues.length * 0.15);
  return { score, issues, observationIssues };
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
  blocks: Awaited<ReturnType<typeof readParseBlocks>>,
  block_ids: string[],
): Promise<NeedDraft> {
  if (isTestStub()) {
    return { gaps: [] };
  }
  const raw = await completeJson(ctx.complete, {
    system: NEED_PROPOSER_SYSTEM,
    user: needProposerUser({
      workspace_id: input.workspace_id,
      source_file_id: input.source_file_id,
      block_ids,
      blocks,
      critiques: round === 0 ? [] : critiques,
    }),
    purpose: `need_extract:proposer:r${round}`,
  });
  if (round > 0 && prior && (!raw || (raw as { gaps?: unknown[] }).gaps?.length === 0)) {
    return prior;
  }
  return normalizeDraft(raw, input.source_file_id);
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
    const stub = isTestStub();
    const blocks = stub ? [] : (input.block_ids.length
      ? await readParseBlocksByIds(input.workspace_id, input.block_ids)
      : await readParseBlocks(input.workspace_id, input.source_file_id))
      .filter((row) => row.source_file_id === input.source_file_id);
    const block_ids = blocks.map((block) => block.id);
    const availableIds = new Set(blocks.map((block) => block.id));
    const missingIds = input.block_ids.filter((id) => !availableIds.has(id));
    const persisted = stub ? [] : await listActiveSourceClaims(input.workspace_id, input.source_file_id);
    const persistedItems: SnapshotItem[] = persisted.map((claim) => {
      const provenance = claimMetadata(claim).provenance;
      return {
        item_kind: claim.claim_type as SnapshotItem["item_kind"], item_ref: claim.id,
        statement: claim.statement,
        provenance: Array.isArray(provenance) ? provenance.flatMap((span) => {
          if (!span || typeof span !== "object") return [];
          const record = span as Record<string, unknown>;
          return typeof record.source_file_id === "string" && typeof record.block_id === "string"
            && typeof record.quote === "string"
            ? [{ source_file_id: record.source_file_id, block_id: record.block_id, quote: record.quote }] : [];
        }) : [],
      };
    });

    const cycle = await runShallowAgenticCycle<NeedDraft>({
      run: ctx.run,
      onSnapshot: async (draft): Promise<ProductionSignals> => ({
        quote_validity: inspectQuoteSpans({ spans: draft.gaps.flatMap((gap) => gap.provenance ?? []), blocks }).signals,
        invariant_failures: critiqueDraft(draft, input.source_file_id, blocks).issues.map((issue) => issue.claim),
        completeness: "not_checked",
      }),
      proposer: (round, prior, critiques) => proposeNeeds(ctx, input, round, prior, critiques, blocks, block_ids),
      onCompleteness: stub ? undefined : async (draft, prior_open_issues) => {
        const items: SnapshotItem[] = [
          ...persistedItems,
          ...draft.gaps.map((gap, index) => ({ item_kind: "gap" as const,
            item_ref: `draft-gap-${index}`, statement: gap.statement,
            provenance: gap.provenance ?? [] })),
        ];
        const assessment = await inspectSnapshotCompleteness({
          blocks, items, prior_open_issues, complete: ctx.complete,
        });
        if (missingIds.length === 0) return assessment;
        return { ...assessment,
          risk_level: assessment.risk_level === "check_failed" ? "check_failed" : "important" as const,
          unchecked_block_ids: [...assessment.unchecked_block_ids, ...missingIds],
        };
      },
      critic: async (draft) => {
        if (stub) return { score: 1, issues: [] };
        return critiqueDraft(draft, input.source_file_id, blocks);
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
