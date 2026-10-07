import { z } from "zod";
import { createHash } from "node:crypto";
import type { AccuracyModuleContext, ModuleResult } from "@/accuracy/kernel/contracts";
import { accuracyTransactionActive } from "@/accuracy/store/db";
import { agenticModule, mechanicalModule } from "../_factory";
import {
  asTacticLifecycle,
  equivalenceQuestions,
  mergeDedupeCandidates,
  type EquivalentPair,
  type MergeCandidate,
  type MergeProvenance,
} from "./engine";
import { judgeEquivalence } from "./judge";
import { isTestStub } from "@/modules/kernel/llm";
import {
  claimMetadata,
  isActiveLedgerClaim,
  listClaims,
  persistClaimPatch,
  type AccuracyClaimMetadata,
  type AccuracyClaimRow,
} from "@/accuracy/store/claim-store";
import {
  isHumanProtectedClaim,
  mergeRejectedPairs,
  preserveHumanLocks,
} from "@/accuracy/store/claim-edit";
import { reassignCoverageClaimId } from "@/accuracy/store/coverage-store";
import { nowIso } from "@/modules/kernel/ids";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { mergeStructuredFields, readStructuredFields } from "@/accuracy/domain/structured-fields";

export {
  mergeDedupeCandidates,
  equivalenceQuestions,
  identityKeys,
  packsMayMerge,
  extractDeterministicIds,
} from "./engine";
export { judgeEquivalence } from "./judge";

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
    structured: readStructuredFields(claim),
    created_at: claim.created_at,
    protected: isHumanProtectedClaim(claim),
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
  reason: z.enum(["identity", "statement", "model_equivalence", "transitive"]),
  keys: z.array(z.string()),
  rationale: z.string().nullable().optional(),
});

export const mergeDedupeOutputSchema = z.object({
  workspace_id: z.string(),
  /** `stub`: test stub, same-block pairs were not put to a model. */
  mode: z.enum(["llm", "stub"]),
  /** Same-block pairs put to the equivalence judge (or left unjudged under the stub). */
  judged_pairs: z.number().int(),
  merged: z.number().int(),
  survivors: z.number().int(),
  contradictions: z.number().int(),
  merges: z.array(mergeRowSchema),
  /** Merges found but not applied: the duplicate is validated / human-edited. A human confirms. */
  proposed: z.number().int().default(0),
  proposals: z.array(mergeRowSchema).default([]),
  contradiction_rows: z.array(contradictionSchema),
});

export type MergeDedupeOutput = z.infer<typeof mergeDedupeOutputSchema>;

/** Exact server-captured inputs, including human locks, rejections and pack identity. */
export async function captureMergeInputs(workspace_id: string) {
  const [claims, sources] = await Promise.all([
    listClaims(workspace_id, { limit: 1000 }),
    listSourceFiles(workspace_id),
  ]);
  const packBySource = new Map(
    sources.map((row) => [row.id, row.reference_pack_id ?? null]),
  );
  const active = claims.filter(isActiveLedgerClaim).sort((a, b) => a.id.localeCompare(b.id));
  const candidates = active.map((row) => claimToMergeCandidate(row, packBySource));
  const blocked = mergeRejectedPairs(active);
  const questions = equivalenceQuestions(candidates, blocked);
  const revision = createHash("sha256").update(JSON.stringify({ active,
    packs: [...packBySource.entries()].sort(([a], [b]) => a.localeCompare(b)),
  }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
  return { workspace_id, revision, active, candidates, blocked, questions };
}

export type MergeInputs = Awaited<ReturnType<typeof captureMergeInputs>>;
export type MergeJudgment = { revision: string; stub: boolean; equivalent: EquivalentPair[] };

/** Preparation never applies ledger or coverage changes. */
export async function prepareMergeJudgment(inputs: MergeInputs, ctx: AccuracyModuleContext): Promise<MergeJudgment> {
  if (accuracyTransactionActive()) throw new Error("Merge preparation must run outside every Accuracy transaction.");
  const stub = isTestStub();
  if (stub) ctx.run.note("merge:test-stub", { unjudged_pairs: inputs.questions.length });
  const equivalent = stub ? [] : await judgeEquivalence({ ctx, questions: inputs.questions, candidates: inputs.candidates });
  return { revision: inputs.revision, stub, equivalent };
}

/** A prepared judgment can only apply to precisely the captured server input. */
export async function applyMergeJudgment(inputs: MergeInputs, judgment: MergeJudgment, ctx: AccuracyModuleContext): Promise<ModuleResult<MergeDedupeOutput>> {
  if (inputs.revision !== judgment.revision) throw new Error("Prepared merge inputs are stale.");
  const input = { workspace_id: inputs.workspace_id };
  const { active, candidates, blocked, questions } = inputs;
  const { stub, equivalent } = judgment;
  const result = mergeDedupeCandidates(candidates, { equivalent, blocked });
  const byId = new Map(active.map((row) => [row.id, row]));

  for (const [duplicateId, survivorId] of Object.entries(result.absorbed)) {
    const duplicate = byId.get(duplicateId);
    if (!duplicate) continue;
    // Defence in depth: never auto-merge away a validated or human-edited claim.
    if (isHumanProtectedClaim(duplicate)) continue;
    const meta = claimMetadata(duplicate);
    const mergeRow = result.merges.find((m) => m.duplicate_id === duplicateId);
    await persistClaimPatch({
      workspace_id: input.workspace_id,
      claim_id: duplicateId,
      status: "merged",
      metadata: {
        ...meta,
        pre_merge_status: duplicate.status,
        merged_into: survivorId,
        merge_reason: mergeRow?.reason ?? "transitive",
        merge_rationale: mergeRow?.rationale ?? null,
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
      metadata: preserveHumanLocks(meta, {
        ...meta,
        external_id: survivor.external_id ?? meta.external_id ?? null,
        reference_pack_id: survivor.reference_pack_id ?? meta.reference_pack_id ?? null,
        tactic_status: survivor.tactic_status ?? meta.tactic_status ?? null,
        structured: mergeStructuredFields(readStructuredFields(row), absorbedIds.flatMap(id => {
          const duplicate = byId.get(id);
          return duplicate ? [readStructuredFields(duplicate)] : [];
        })),
        provenance: survivor.provenance,
        merged_from: mergedFrom,
        merged_into: null,
      }),
    });
  }

  // Proposals: persist on the protected duplicate; a human confirms or dismisses.
  const proposalByDuplicate = new Map(result.proposals.map((row) => [row.duplicate_id, row]));
  const proposedAt = nowIso();
  const fresh = (await listClaims(input.workspace_id, { limit: 1000 })).filter(isActiveLedgerClaim);
  for (const row of fresh) {
    const meta = claimMetadata(row);
    const proposal = proposalByDuplicate.get(row.id);
    const existing = meta.merge_proposal ?? null;
    if (proposal) {
      if (existing && existing.survivor_id === proposal.survivor_id) continue;
      await persistClaimPatch({
        workspace_id: input.workspace_id,
        claim_id: row.id,
        metadata: {
          ...meta,
          merge_proposal: {
            survivor_id: proposal.survivor_id,
            reason: proposal.reason,
            keys: proposal.keys,
            rationale: proposal.rationale ?? null,
            proposed_at: proposedAt,
          },
        },
      });
    } else if (existing) {
      await persistClaimPatch({
        workspace_id: input.workspace_id,
        claim_id: row.id,
        metadata: { ...meta, merge_proposal: null },
      });
    }
  }

  const output: MergeDedupeOutput = {
    workspace_id: input.workspace_id,
    mode: stub ? "stub" : "llm",
    judged_pairs: questions.length,
    merged: Object.keys(result.absorbed).length,
    survivors: result.survivors.length,
    contradictions: result.contradictions.length,
    merges: result.merges,
    proposed: result.proposals.length,
    proposals: result.proposals,
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
    summary: `${
      output.merged === 0
        ? `Merge dedupe — ${output.survivors} survivor(s), no duplicates`
        : `Merge dedupe — collapsed ${output.merged} duplicate(s) into ${output.survivors} survivor(s)`
    }${
      result.proposals.length > 0
        ? ` · ${result.proposals.length} merge(s) proposed for human review (validated / human-edited)`
        : ""
    }${
      stub && questions.length > 0
        ? ` · test stub (SYNAPSE_TEST_STUB_LLM): ${questions.length} same-block pair(s) not judged`
        : questions.length > 0
          ? ` · judge decided ${questions.length} same-block pair(s)`
          : ""
    }`,
  };
}

/**
 * Merge / dedupe. Shared study IDs and identical statements merge as facts;
 * differently worded candidates citing the same block are merged only when the
 * LLM equivalence judge says they are the same item. No LLM, no judgement:
 * the run throws when there is a pair to decide and no model to ask.
 */
export const mergeDedupeModule = agenticModule({
  id: "merge-dedupe.judge-v1",
  call_kind: "merge_dedupe",
  title: "Merge dedupe",
  summary: "Study-ID aware merge; LLM judge decides same-block equivalence.",
  inputSchema: z.object({ workspace_id: z.string() }),
  outputSchema: mergeDedupeOutputSchema,
  run: async (input, ctx) => {
    const inputs = await captureMergeInputs(input.workspace_id);
    const judgment = await prepareMergeJudgment(inputs, ctx);
    return applyMergeJudgment(inputs, judgment, ctx);
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

mergeDedupeModule.manifest.version = "0.2.0";
