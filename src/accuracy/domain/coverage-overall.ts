import type { CoverageOverall } from "@/accuracy/store/coverage-store";

export function canonicalCoverageOverall(value: string | null | undefined): CoverageOverall {
  switch ((value ?? "").trim().toLowerCase()) {
    case "full": case "covers": return "full";
    case "partial": return "partial";
    case "limited": return "limited";
    case "none": case "not_relevant": return "not_relevant";
    default: return "pending";
  }
}
