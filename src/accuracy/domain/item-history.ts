/** Pure identity rules and public shapes for generated item histories. */
import { createHash } from "node:crypto";
import type { AccuracyClaimRow, AccuracyClaimType } from "@/accuracy/store/claim-store";

export class ItemHistoryError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "ItemHistoryError";
  }
}

export type ItemVersion = {
  id: string; claim_id: string; run_id: string; snapshot_id: string | null;
  iteration: number | null; item_index: number; payload: Record<string, unknown>;
  source_file_id: string; created_at: string;
};

export type ItemRelationship = {
  id: string; kind: "same_item" | "split" | "merge";
  predecessor_ids: string[]; successor_ids: string[]; rationale: string;
  decision: "confirm" | "reject" | null;
};

export type ItemHistory = {
  claim: AccuracyClaimRow; versions: ItemVersion[];
  relationships: ItemRelationship[]; canonical_claim_id: string;
};

/** Permit only active judged entries into downstream assembly readers. */
export function isDownstreamClaim(claim: Pick<AccuracyClaimRow, "status" | "metadata">): boolean {
  const metadata = claim.metadata as Record<string, unknown> | null;
  return claim.status !== "merged" && claim.status !== "rejected" && metadata?.history_only !== true;
}

/** Canonical JSON preserves array order and every item field except a generated top-level ID. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

/** Hash an exact generated item; only the model-assigned top-level ID is omitted. */
export function generatedItemFingerprint(claim_type: AccuracyClaimType, payload: Record<string, unknown>): string {
  if (claim_type !== "gap" && claim_type !== "tactic") throw new ItemHistoryError("invalid_input", "Unsupported item type.");
  const { id: _generatedId, ...content } = payload;
  return createHash("sha256").update(JSON.stringify([claim_type, canonical(content)])).digest("hex");
}
