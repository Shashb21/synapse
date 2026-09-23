import { z } from "zod";
import { mechanicalModule } from "../_factory";
import {
  asTacticLifecycle,
  mergeDedupeCandidates,
  type MergeCandidate,
  type MergeProvenance,
} from "./engine";
import {
  claimMetadata,
  isActiveLedgerClaim,
  listClaims,
  persistClaimPatch,
  type AccuracyClaimMetadata,
  type AccuracyClaimRow,
} from "@/accuracy/store/claim-store";
import { reassignCoverageClaimId } from "@/accuracy/store/coverage-store";
import { listSourceFiles } from "@/accuracy/store/source-store";

export {
  mergeDedupeCandidates,
  identityKeys,
  packsMayMerge,
  extractDeterministicIds,
} from "./engine";

function provenanceFromMeta(meta: AccuracyClaimMetadata): MergeProvenance[] {
  if (!Array.isArray(meta.provenance)) return [];
  const out: MergeProvenance[] = [];
  for (const raw of meta.provenance) {
    if (!raw || typeof raw !== "object") continue;
    const span = raw as { source_file_id?: unknown; block_id?: unknown; quote?: unknown };
    if (
      typeof span.source_file_id === "string" &&
      typeof span.block_id === "string" &&
      typeof span.quote === "string"
    ) {
      out.push({
        source_file_id: span.source_file_id,
        block_id: span.block_id,
        quote: span.quote,
      });
    }
  }
  return out;
}

function externalIdFromMeta(meta: AccuracyClaimMetadata): string | null {
  if (typeof meta.external_id === "string" && meta.external_id.trim()) {
    return meta.external_id.trim();
  }
  if (typeof meta.identifier === "string" && meta.identifier.trim()) {
    return meta.identifier.trim();
  }
  return null;
}

function packFromClaim(
  claim: AccuracyClaimRow,
  packBySource: Map<string, string | null>,
): string | null {
  const meta = claimMetadata(claim);
  if (typeof meta.reference_pack_id === "string" && meta.reference_pack_id.trim()) {
    return meta.reference_pack_id.trim();
  }
  if (claim.source_file_id) {
    return packBySource.get(claim.source_file_id) ?? null;
  }
  return null;
}

export function claimToMergeCandidate(
  claim: AccuracyClaimRow,
  packBySource: Map<string, string | null>,
): MergeCandidate {
  const meta = claimMetadata(claim);
  return {
    id: claim.id,
    claim_type: claim.claim_type === "tactic" ? "tactic" : "gap",
    statement: claim.statement,
    validated: claim.validated,
    status: claim.status,
    source_file_id: claim.source_file_id,
    reference_pack_id: packFromClaim(claim, packBySource),
    external_id: externalIdFromMeta(meta),
    tactic_status: asTacticLifecycle(meta.tactic_status) ?? asTacticLifecycle(claim.status),
    provenance: provenanceFromMeta(meta),
    created_at: claim.created_at,
  };
}

const contradictionSchema = z.object({
  keep_id: z.string(),
  other_id: z.string(),
  claim_type: z.enum(["gap", "tactic"]),
  field: z.literal("status"),
  values: z.tuple([z.string(), z.string()]),
  reason: z.string(),
});

const mergeRowSchema = z.object({
  survivor_id: z.string(),
  duplicate_id: z.string(),
  reason: z.enum(["identity", "statement", "block_overlap"]),
  keys: z.array(z.string()),
});

export const mergeDedupeOutputSchema = z.object({
  workspace_id: z.string(),
  merged: z.number().int(),
  survivors: z.number().int(),
  contradictions: z.number().int(),
  merges: z.array(mergeRowSchema),
  contradiction_rows: z.array(contradictionSchema),
});

export type MergeDedupeOutput = z.infer<typeof mergeDedupeOutputSchema>;

export const mergeDedupeModule = mechanicalModule({
  id: "merge-dedupe.local-v1",
  call_kind: "merge_dedupe",
  title: "Merge dedupe",
  summary: "Study-ID aware merge of inventory + need candidates.",
  inputSchema: z.object({ workspace_id: z.string() }),
  outputSchema: mergeDedupeOutputSchema,
  run: async (input, ctx) => {
    const [claims, sources] = await Promise.all([
      listClaims(input.workspace_id, { limit: 1000 }),
      listSourceFiles(input.workspace_id),
    ]);
    const packBySource = new Map(
      sources.map((row) => [row.id, row.reference_pack_id ?? null]),
    );
    const active = claims.filter(isActiveLedgerClaim);
    const candidates = active.map((row) => claimToMergeCandidate(row, packBySource));
    const result = mergeDedupeCandidates(candidates);
    const byId = new Map(active.map((row) => [row.id, row]));

    for (const [duplicateId, survivorId] of Object.entries(result.absorbed)) {
      const duplicate = byId.get(duplicateId);
      if (!duplicate) continue;
      const meta = claimMetadata(duplicate);
      const mergeRow = result.merges.find((m) => m.duplicate_id === duplicateId);
      await persistClaimPatch({
        workspace_id: input.workspace_id,
        claim_id: duplicateId,
        status: "merged",
        metadata: {
          ...meta,
          merged_into: survivorId,
          merge_reason: mergeRow?.reason ?? "identity",
        },
      });
      const role = duplicate.claim_type === "tactic" ? "tactic" : "gap";
      await reassignCoverageClaimId({
        workspace_id: input.workspace_id,
        from_id: duplicateId,
        to_id: survivorId,
        role,
      });
    }

    for (const survivor of result.survivors) {
      const row = byId.get(survivor.id);
      if (!row) continue;
      const meta = claimMetadata(row);
      const absorbedIds = Object.entries(result.absorbed)
        .filter(([, keep]) => keep === survivor.id)
        .map(([dup]) => dup);
      if (absorbedIds.length === 0 && survivor.provenance.length === provenanceFromMeta(meta).length) {
        continue;
      }
      const mergedFrom = [
        ...new Set([...(Array.isArray(meta.merged_from) ? meta.merged_from : []), ...absorbedIds]),
      ];
      await persistClaimPatch({
        workspace_id: input.workspace_id,
        claim_id: survivor.id,
        metadata: {
          ...meta,
          external_id: survivor.external_id ?? meta.external_id ?? null,
          reference_pack_id: survivor.reference_pack_id ?? meta.reference_pack_id ?? null,
          tactic_status: survivor.tactic_status ?? meta.tactic_status ?? null,
          provenance: survivor.provenance,
          merged_from: mergedFrom,
          merged_into: null,
        },
      });
    }

    const output: MergeDedupeOutput = {
      workspace_id: input.workspace_id,
      merged: Object.keys(result.absorbed).length,
      survivors: result.survivors.length,
      contradictions: result.contradictions.length,
      merges: result.merges,
      contradiction_rows: result.contradictions,
    };
    ctx.run.note("merge:result", {
      merged: output.merged,
      survivors: output.survivors,
      contradictions: output.contradictions,
      absorbed: result.absorbed,
    });
    return {
      output,
      summary:
        output.merged === 0
          ? `Merge dedupe — ${output.survivors} survivor(s), no duplicates`
          : `Merge dedupe — collapsed ${output.merged} duplicate(s) into ${output.survivors} survivor(s)`,
    };
  },
});

export const pairGenerateModule = mechanicalModule({
  id: "pair-generate.local-v1",
  call_kind: "pair_generate",
  title: "Pair generator",
  summary: "Deterministic gap↔tactic pair candidates.",
  inputSchema: z.object({ workspace_id: z.string() }),
  outputSchema: z.object({ pairs: z.array(z.object({ gap_id: z.string(), tactic_id: z.string() })) }),
  run: async () => ({ output: { pairs: [] }, summary: "Pair generator stub" }),
});
