import { z } from "zod";
import type { EvidenceGap } from "./types";

/** The direct fields and decision context the editor actually saw. */
export const gapEditSnapshotSchema = z.object({
  name: z.string(),
  statement: z.string(),
  domain: z.string(),
  objective_id: z.string(),
  priority_context_version: z.string().nullable(),
});
export type GapEditSnapshot = z.infer<typeof gapEditSnapshotSchema>;

export function gapEditSnapshot(gap: EvidenceGap): GapEditSnapshot {
  return {
    name: gap.name, statement: gap.statement, domain: gap.domain,
    objective_id: gap.objective_id, priority_context_version: gap.priority_context_version ?? null,
  };
}

export function requireGapEditSnapshot(gap: EvidenceGap, expected: unknown): void {
  const parsed = gapEditSnapshotSchema.safeParse(expected);
  const current = gapEditSnapshot(gap);
  if (!parsed.success || (Object.keys(current) as (keyof GapEditSnapshot)[]).some(key => parsed.data[key] !== current[key])) {
    throw new Error("Gap or linked objective context changed, or its snapshot is missing. Your values and reason have not been saved. Reload the latest gap and retry.");
  }
}
