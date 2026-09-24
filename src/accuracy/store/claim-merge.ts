/**
 * Human merge / unmerge / dismiss of duplicate ledger claims.
 * Every action needs a rationale and is written to both claims' edit_history.
 */
import type { Actor } from "@/accuracy/kernel/contracts";
import { nowIso } from "@/modules/kernel/ids";
import {
  claimMetadata,
  getClaim,
  requireValidationRationale,
  type AccuracyClaimMetadata,
  type AccuracyClaimRow,
} from "./claim-store";
import { humanLockedFields, withHumanEdit, writeClaimRow } from "./claim-edit";
import { reassignCoverageClaimId } from "./coverage-store";
import { ensureAccuracySchema } from "./db";

function provenanceSpans(meta: AccuracyClaimMetadata): Record<string, unknown>[] {
  return Array.isArray(meta.provenance)
    ? (meta.provenance as unknown[]).filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
      )
    : [];
}

function unionSpans(
  a: Record<string, unknown>[],
  b: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const span of [...a, ...b]) {
    const key = `${String(span.source_file_id)}::${String(span.block_id)}::${String(span.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(span);
  }
  return out;
}

function withRejected(meta: AccuracyClaimMetadata, otherId: string): string[] {
  const prev = Array.isArray(meta.merge_rejected_with) ? meta.merge_rejected_with : [];
  return [...new Set([...prev, otherId])].sort();
}

function restoredStatus(claim: AccuracyClaimRow, meta: AccuracyClaimMetadata): string {
  const prev = typeof meta.pre_merge_status === "string" ? meta.pre_merge_status : null;
  if (prev && prev !== "merged") return prev;
  if (claim.validated) return "validated";
  if (claim.claim_type === "tactic" && typeof meta.tactic_status === "string") {
    return meta.tactic_status;
  }
  return "draft";
}

async function requirePair(workspace_id: string, a_id: string, b_id: string) {
  if (a_id === b_id) throw new Error("Pick two different claims.");
  const [a, b] = await Promise.all([getClaim(workspace_id, a_id), getClaim(workspace_id, b_id)]);
  if (!a) throw new Error(`Unknown claim: ${a_id}`);
  if (!b) throw new Error(`Unknown claim: ${b_id}`);
  if (a.claim_type !== b.claim_type) {
    throw new Error("Only claims of the same type (gap↔gap, tactic↔tactic) can be merged.");
  }
  return { a, b };
}

/**
 * Human merge: `duplicate` is marked merged into `survivor`. Provenance is
 * unioned into the survivor (unless the survivor's provenance is human-locked)
 * and coverage joins are re-pointed at the survivor.
 */
export async function manualMergeClaims(args: {
  workspace_id: string;
  survivor_id: string;
  duplicate_id: string;
  rationale: string;
  actor: Actor;
}): Promise<{ survivor: AccuracyClaimRow; duplicate: AccuracyClaimRow }> {
  const rationale = requireValidationRationale(args.rationale);
  await ensureAccuracySchema();
  const { a: survivor, b: duplicate } = await requirePair(
    args.workspace_id,
    args.survivor_id,
    args.duplicate_id,
  );
  if (survivor.status === "merged") {
    throw new Error("The surviving claim is itself merged — unmerge it or pick its survivor.");
  }
  if (duplicate.status === "merged") throw new Error("That claim is already merged.");
  const at = nowIso();

  const dupMeta = claimMetadata(duplicate);
  const nextDup = withHumanEdit(
    {
      ...dupMeta,
      pre_merge_status: duplicate.status,
      merged_into: survivor.id,
      merge_reason: "human",
      merge_rationale: rationale,
      merge_proposal: null,
    },
    {
      action: "merge",
      fields: ["merged_into"],
      before: { status: duplicate.status, merged_into: dupMeta.merged_into ?? null },
      after: { status: "merged", merged_into: survivor.id },
      rationale,
      actor: args.actor,
      at,
      lock: ["merge"],
    },
  );

  const survMeta = claimMetadata(survivor);
  const mergedFrom = [
    ...new Set([
      ...(Array.isArray(survMeta.merged_from) ? survMeta.merged_from : []),
      duplicate.id,
    ]),
  ];
  const provenanceLocked = humanLockedFields(survMeta).some(
    (key) => key === "provenance" || key === "provenance_quote",
  );
  const nextSurv = withHumanEdit(
    {
      ...survMeta,
      merged_from: mergedFrom,
      provenance: provenanceLocked
        ? survMeta.provenance
        : unionSpans(provenanceSpans(survMeta), provenanceSpans(dupMeta)),
      external_id: survMeta.external_id ?? dupMeta.external_id ?? null,
    },
    {
      action: "merge",
      fields: ["merged_from"],
      before: { merged_from: survMeta.merged_from ?? [] },
      after: { merged_from: mergedFrom, absorbed: duplicate.id },
      rationale,
      actor: args.actor,
      at,
      lock: ["merge"],
    },
  );

  const dupRow = await writeClaimRow({
    workspace_id: args.workspace_id,
    claim: duplicate,
    status: "merged",
    metadata: nextDup,
    at,
  });
  const survRow = await writeClaimRow({
    workspace_id: args.workspace_id,
    claim: survivor,
    metadata: nextSurv,
    at,
  });
  await reassignCoverageClaimId({
    workspace_id: args.workspace_id,
    from_id: duplicate.id,
    to_id: survivor.id,
    role: duplicate.claim_type === "tactic" ? "tactic" : "gap",
  });
  return { survivor: survRow, duplicate: dupRow };
}

/**
 * Undo a merge (human or AI): clear `merged_into`, restore the pre-merge
 * status, drop the id from the survivor's `merged_from`, and record the pair
 * as "not the same" so later merge-dedupe runs never re-merge or re-propose it.
 * Coverage joins moved to the survivor at merge time stay on the survivor.
 */
export async function unmergeClaim(args: {
  workspace_id: string;
  claim_id: string;
  rationale: string;
  actor: Actor;
}): Promise<{ claim: AccuracyClaimRow; survivor: AccuracyClaimRow | null }> {
  const rationale = requireValidationRationale(args.rationale);
  await ensureAccuracySchema();
  const claim = await getClaim(args.workspace_id, args.claim_id);
  if (!claim) throw new Error(`Unknown claim: ${args.claim_id}`);
  const meta = claimMetadata(claim);
  const survivorId = typeof meta.merged_into === "string" ? meta.merged_into : null;
  if (claim.status !== "merged" && !survivorId) {
    throw new Error("That claim is not merged.");
  }
  const at = nowIso();
  const status = restoredStatus(claim, meta);
  const nextMeta = withHumanEdit(
    {
      ...meta,
      merged_into: null,
      merge_reason: null,
      merge_rationale: null,
      pre_merge_status: null,
      merge_rejected_with: survivorId ? withRejected(meta, survivorId) : meta.merge_rejected_with,
    },
    {
      action: "unmerge",
      fields: ["merged_into"],
      before: { status: claim.status, merged_into: survivorId },
      after: { status, merged_into: null },
      rationale,
      actor: args.actor,
      at,
      lock: ["merge"],
    },
  );
  const restored = await writeClaimRow({
    workspace_id: args.workspace_id,
    claim,
    status,
    metadata: nextMeta,
    at,
  });

  let survivorRow: AccuracyClaimRow | null = null;
  if (survivorId) {
    const survivor = await getClaim(args.workspace_id, survivorId);
    if (survivor) {
      const survMeta = claimMetadata(survivor);
      const mergedFrom = (Array.isArray(survMeta.merged_from) ? survMeta.merged_from : []).filter(
        (id) => id !== claim.id,
      );
      survivorRow = await writeClaimRow({
        workspace_id: args.workspace_id,
        claim: survivor,
        metadata: withHumanEdit(
          {
            ...survMeta,
            merged_from: mergedFrom,
            merge_rejected_with: withRejected(survMeta, claim.id),
          },
          {
            action: "unmerge",
            fields: ["merged_from"],
            before: { merged_from: survMeta.merged_from ?? [] },
            after: { merged_from: mergedFrom, released: claim.id },
            rationale,
            actor: args.actor,
            at,
            lock: [],
          },
        ),
        at,
      });
    }
  }
  return { claim: restored, survivor: survivorRow };
}

/** Human says "not a duplicate" to a model merge proposal. Never re-proposed. */
export async function dismissMergeProposal(args: {
  workspace_id: string;
  claim_id: string;
  rationale: string;
  actor: Actor;
}): Promise<AccuracyClaimRow> {
  const rationale = requireValidationRationale(args.rationale);
  await ensureAccuracySchema();
  const claim = await getClaim(args.workspace_id, args.claim_id);
  if (!claim) throw new Error(`Unknown claim: ${args.claim_id}`);
  const meta = claimMetadata(claim);
  const proposal = meta.merge_proposal;
  if (!proposal) throw new Error("No merge proposal on this claim.");
  const at = nowIso();
  const updated = await writeClaimRow({
    workspace_id: args.workspace_id,
    claim,
    metadata: withHumanEdit(
      {
        ...meta,
        merge_proposal: null,
        merge_rejected_with: withRejected(meta, proposal.survivor_id),
      },
      {
        action: "merge_dismiss",
        fields: ["merge_proposal"],
        before: { merge_proposal: proposal },
        after: { merge_proposal: null },
        rationale,
        actor: args.actor,
        at,
        lock: [],
      },
    ),
    at,
  });
  const other = await getClaim(args.workspace_id, proposal.survivor_id);
  if (other) {
    const otherMeta = claimMetadata(other);
    await writeClaimRow({
      workspace_id: args.workspace_id,
      claim: other,
      metadata: { ...otherMeta, merge_rejected_with: withRejected(otherMeta, claim.id) },
      at,
    });
  }
  return updated;
}
