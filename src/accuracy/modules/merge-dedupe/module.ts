import { z } from "zod";
import { mechanicalModule } from "../_factory";
import {
  mergeDedupeCandidates,
  type MergeCandidate,
  type MergeDedupeResult,
} from "./engine";

const provenanceLiteSchema = z.object({
  source_file_id: z.string().optional(),
  block_id: z.string().optional(),
  quote: z.string().optional(),
});

const candidateSchema = z.object({
  id: z.string(),
  claim_type: z.enum(["gap", "tactic"]),
  statement: z.string().min(1),
  status: z.string().nullable().optional(),
  external_id: z.string().nullable().optional(),
  study_ids: z.array(z.string()).optional(),
  provenance: z.array(provenanceLiteSchema).optional(),
});

const inputSchema = z.object({
  workspace_id: z.string(),
  existing: z.array(candidateSchema).default([]),
  incoming: z.array(candidateSchema).default([]),
});

const decisionSchema = z.object({
  candidate_id: z.string(),
  action: z.enum(["insert", "merge", "skip", "contradict"]),
  matched_id: z.string().nullable(),
  reason: z.string(),
});

const outputSchema = z.object({
  workspace_id: z.string(),
  inserted: z.number().int(),
  merged: z.number().int(),
  skipped: z.number().int(),
  contradictions: z.number().int(),
  decisions: z.array(decisionSchema),
});

export type MergeDedupeInput = z.infer<typeof inputSchema>;
export type MergeDedupeOutput = z.infer<typeof outputSchema>;

export const mergeDedupeModule = mechanicalModule({
  id: "merge-dedupe.local-v1",
  call_kind: "merge_dedupe",
  title: "Merge dedupe",
  summary: "Study-ID aware merge of inventory + need candidates.",
  inputSchema,
  outputSchema,
  run: async (input, ctx) => {
    const result: MergeDedupeResult = mergeDedupeCandidates({
      existing: input.existing as MergeCandidate[],
      incoming: input.incoming as MergeCandidate[],
    });
    ctx.run.note("merge:decisions", {
      inserted: result.inserted,
      merged: result.merged,
      skipped: result.skipped,
      contradictions: result.contradictions,
    });
    return {
      output: {
        workspace_id: input.workspace_id,
        inserted: result.inserted,
        merged: result.merged,
        skipped: result.skipped,
        contradictions: result.contradictions,
        decisions: result.decisions,
      },
      summary: `Merge dedupe — insert ${result.inserted}, merge ${result.merged}, skip ${result.skipped}, contradict ${result.contradictions}`,
    };
  },
});

export const pairGenerateModule = mechanicalModule({
  id: "pair-generate.local-v1",
  call_kind: "pair_generate",
  title: "Pair generator",
  summary: "Deterministic gap↔tactic pair candidates.",
  inputSchema: z.object({ workspace_id: z.string() }),
  outputSchema: z.object({
    pairs: z.array(z.object({ gap_id: z.string(), tactic_id: z.string() })),
  }),
  run: async () => ({ output: { pairs: [] }, summary: "Pair generator stub" }),
});

export {
  mergeDedupeCandidates,
  claimToMergeCandidate,
  extractStudyIds,
  type MergeCandidate,
  type MergeDecision,
  type MergeDedupeResult,
} from "./engine";
