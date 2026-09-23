import type { ParseBlock } from "@/accuracy/store/quote-validator";

export type CoveragePairLabels = {
  gap?: { name?: string; statement?: string };
  tactic?: { name?: string; evidence_question?: string; type?: string };
};

export type CoveragePromptState = {
  gap_id: string;
  tactic_id: string;
  gap: { id: string; name: string | null; statement: string | null };
  tactic: { id: string; name: string | null; evidence_question: string | null; type: string | null };
  evidence_blocks: { id: string; heading: string | null; text: string }[];
};

/** Assemble LLM user payload for one gap↔tactic pair from parse-store blocks. */
export function buildStateFromBlocks(args: {
  gap_id: string;
  tactic_id: string;
  block_bundle_ids: string[];
  blocks: Pick<ParseBlock, "id" | "heading" | "text">[];
  labels?: CoveragePairLabels;
}): CoveragePromptState {
  const byId = new Map(args.blocks.map((block) => [block.id, block]));
  const evidence_blocks = args.block_bundle_ids.flatMap((id) => {
    const block = byId.get(id);
    if (!block) return [];
    return [{ id: block.id, heading: block.heading, text: block.text }];
  });

  return {
    gap_id: args.gap_id,
    tactic_id: args.tactic_id,
    gap: {
      id: args.gap_id,
      name: args.labels?.gap?.name ?? null,
      statement: args.labels?.gap?.statement ?? null,
    },
    tactic: {
      id: args.tactic_id,
      name: args.labels?.tactic?.name ?? null,
      evidence_question: args.labels?.tactic?.evidence_question ?? null,
      type: args.labels?.tactic?.type ?? null,
    },
    evidence_blocks,
  };
}
