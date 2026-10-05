/** Atomic experiment-only materialization after passing the retained no-edit gate. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assemblyExecutionScope, withAssemblyWorkspaceLock } from "@/accuracy/kernel/assembly-context";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { claimMetadata, getClaimsByIds, insertClaim } from "@/accuracy/store/claim-store";
import { insertCoverageJoin, listCoverageJoins } from "@/accuracy/store/coverage-store";
import type { PartialSplitOutput } from "./schema";

/** Insert both draft children, their context spans and supported coverage in one transaction. */
export async function materializeSplit(args: { workspace_id: string; run_id: string; output: PartialSplitOutput; passing_gate: boolean }) {
  if (assemblyExecutionScope().kind !== "experiment" || !args.passing_gate) throw new Error("Split materialization requires an experiment-only passing no-edit gate.");
  return withAssemblyWorkspaceLock(args.workspace_id, async () => {
    const output = args.output;
    const children = [output.addressed, output.residual];
    const existing = await getClaimsByIds(args.workspace_id, children.map(child => child.id));
    const evidenceIds: Record<string, string[]> = {};
    for (const child of children) {
      const metadata = { ...child, split_run_id: args.run_id, split_rationale: output.rationale, support_tactic_ids: output.tactic_ids, support_coverage_ids: output.coverage_ids };
      const previous = existing.find(row => row.id === child.id);
      if (previous && (previous.claim_type !== "gap" || previous.statement !== child.statement || Object.entries(metadata).some(([key, value]) => !isDeepStrictEqual(claimMetadata(previous)[key], value)))) throw new Error("Generated split identity has different durable content.");
      evidenceIds[child.id] = child.source_context.map((span, index) => `prov_split_${createHash("sha256").update(JSON.stringify({ id: child.id, index, span })).digest("hex").slice(0, 40)}`);
      if (!previous) {
        await insertClaim({ id: child.id, workspace_id: args.workspace_id, claim_type: "gap", statement: child.statement, status: "draft", validated: false, metadata });
        await accuracyDb().insert(t.accuracyProvenance).values(child.source_context.map((span, index) => ({ id: evidenceIds[child.id][index], workspace_id: args.workspace_id, claim_id: child.id, source_file_id: span.source_file_id, block_id: span.block_id, quote: span.quote })));
      }
    }
    const stored = await listCoverageJoins(args.workspace_id);
    const coverage = [];
    for (const tactic_id of output.tactic_ids) {
      const rationale = `Generated addressed slice from split ${args.run_id}; parent coverage ${output.coverage_ids.join(", ")}: ${output.rationale}`;
      const previous = stored.filter(row => row.gap_id === output.addressed_gap_id && row.tactic_id === tactic_id);
      if (previous.length > 1 || previous.some(row => row.overall !== "full" || !row.validated || row.rationale !== rationale)) throw new Error("Generated split coverage has different durable content.");
      coverage.push(previous[0] ?? await insertCoverageJoin({ workspace_id: args.workspace_id, gap_id: output.addressed_gap_id, tactic_id, overall: "full", validated: true, rationale }));
    }
    return { evidenceIds, coverage };
  });
}
