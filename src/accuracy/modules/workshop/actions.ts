import { requireValidationRationale } from "@/accuracy/store/claim-store";
import type { WorkshopActionKind, WorkshopCoverageStatus } from "./readiness";

export type { WorkshopActionKind };

export const WORKSHOP_ACTION_KINDS = [
  "mark_addressed",
  "remap",
  "park",
  "set_priority",
] as const satisfies readonly WorkshopActionKind[];

export type CoverageOverallWrite = "covers" | "partial" | "none" | "unknown";
export type PriorityBandWrite = "high" | "medium" | "low";

export type WorkshopActionInput = {
  kind: WorkshopActionKind;
  gap_id: string;
  rationale: string;
  tactic_id?: string;
  overall?: CoverageOverallWrite;
  priority?: PriorityBandWrite;
};

export function parseWorkshopActionKind(value: unknown): WorkshopActionKind {
  if (value === "mark_addressed" || value === "remap" || value === "park" || value === "set_priority") {
    return value;
  }
  throw new Error("Unknown workshop action.");
}

/** Rationale is required for every workshop write — no silent ledger edits. */
export function assertWorkshopAction(input: WorkshopActionInput): {
  kind: WorkshopActionKind;
  gap_id: string;
  rationale: string;
  tactic_id?: string;
  overall?: CoverageOverallWrite;
  priority?: PriorityBandWrite;
} {
  const rationale = requireValidationRationale(input.rationale);
  const gap_id = input.gap_id.trim();
  if (!gap_id) throw new Error("gap_id is required.");

  if (input.kind === "mark_addressed") {
    const tactic_id = input.tactic_id?.trim();
    if (!tactic_id) throw new Error("Mark addressed requires a tactic from this workshop snapshot.");
    return { kind: input.kind, gap_id, rationale, tactic_id };
  }
  if (input.kind === "remap") {
    const tactic_id = input.tactic_id?.trim();
    const overall = input.overall;
    if (!tactic_id) throw new Error("Remap requires a tactic from this workshop snapshot.");
    if (overall !== "covers" && overall !== "partial" && overall !== "none" && overall !== "unknown") {
      throw new Error("Remap requires a coverage overall.");
    }
    return { kind: input.kind, gap_id, rationale, tactic_id, overall };
  }
  if (input.kind === "set_priority") {
    const priority = input.priority;
    if (priority !== "high" && priority !== "medium" && priority !== "low") {
      throw new Error("Priority must be high, medium, or low.");
    }
    return { kind: input.kind, gap_id, rationale, priority };
  }
  return { kind: "park", gap_id, rationale };
}

export function coverageStatusAfterOverall(overall: CoverageOverallWrite): WorkshopCoverageStatus {
  if (overall === "covers") return "addressed";
  if (overall === "partial") return "partial";
  return "open";
}

export function workshopWritesLedger(kind: WorkshopActionKind): boolean {
  return kind === "mark_addressed" || kind === "remap" || kind === "set_priority";
}
