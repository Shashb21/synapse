/**
 * Server → client mapping of a claim row to the editable field values used by
 * the ledger Edit form and the Gantt schedule editor. Stored values (what a
 * human or extractor wrote), never the shifted Gantt projection.
 */
import type { AccuracyClaimMetadata } from "@/accuracy/store/claim-store";

export type ClaimFieldSnapshot = {
  statement: string;
  external_id: string;
  provenance_quote: string;
  status_override: "" | "open" | "partial" | "addressed";
  type: string;
  tactic_status: string;
  evidence_question: string;
  design_summary: string;
  start: string;
  end: string;
  readout: string;
  depends_on: string[];
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function day(value: unknown): string {
  const text = str(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

const LIFECYCLES = new Set(["completed", "ongoing", "planned", "proposed", "cancelled"]);

export function claimFieldSnapshot(claim: {
  statement: string;
  status: string;
  metadata: unknown;
}): ClaimFieldSnapshot {
  const meta = (claim.metadata ?? {}) as AccuracyClaimMetadata;
  const override =
    meta.status_override && typeof meta.status_override === "object"
      ? str(meta.status_override.status)
      : "";
  const firstSpan = Array.isArray(meta.provenance)
    ? (meta.provenance[0] as { quote?: unknown } | undefined)
    : undefined;
  const tacticStatus = str(meta.tactic_status) || (LIFECYCLES.has(claim.status) ? claim.status : "");
  return {
    statement: claim.statement,
    external_id: str(meta.external_id),
    provenance_quote: str(firstSpan?.quote),
    status_override:
      override === "open" || override === "partial" || override === "addressed" ? override : "",
    type: str(meta.type) || str(meta.tactic_type),
    tactic_status: LIFECYCLES.has(tacticStatus) ? tacticStatus : "",
    evidence_question: str(meta.evidence_question),
    design_summary: str(meta.design_summary),
    start: day(meta.start),
    end: day(meta.end),
    readout: day(meta.readout) || day(meta.readout_date) || day(meta.evidence_available),
    depends_on: Array.isArray(meta.depends_on)
      ? meta.depends_on.filter((id): id is string => typeof id === "string")
      : [],
  };
}
