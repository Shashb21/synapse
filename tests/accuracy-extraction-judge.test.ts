import { describe, expect, it } from "vitest";
import { selectExtractionSnapshot, sourceAssessmentChecked } from "@/accuracy/modules/extraction-judge";
import type { RetainedCandidate } from "@/accuracy/kernel/agentic";
import type { SnapshotCompletenessAssessment, SuspectedOmission } from "@/accuracy/modules/completeness-audit/snapshot-inspector";

const clean: SnapshotCompletenessAssessment = { risk_level: "none_detected", checked_block_ids: ["B1"],
  unchecked_block_ids: [], suspected_omissions: [], prior_issue_resolutions: [] };
const omission: SuspectedOmission = { issue_id: "missing-1", item_kind: "gap", summary: "Missing regional need",
  source_ref: { source_file_id: "F1", block_id: "B1" }, evidence_quote: "Regional need",
  basis: "explicit", importance: "important", reason: "Absent", suggested_action: "Review the regional need" };
function candidate(iteration: number, completeness = clean): RetainedCandidate<{ text: string }> {
  return { iteration, draft: { text: `V${iteration}` },
    signals: { quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 },
      invariant_failures: [], completeness: "not_checked" },
    assessment: { score: 1, issues: [], completeness } };
}

describe("production source-evidence comparison", () => {
  it("prefers complete earlier coverage while keeping important later omissions observable", () => {
    const later = candidate(3, { ...clean, risk_level: "important", suspected_omissions: [omission] });
    const selected = selectExtractionSnapshot([candidate(1), later], () => true);
    expect(selected.selected_iteration).toBe(1);
    expect(selected.reason).toContain("0 important omissions");
    expect(later.assessment.completeness.suspected_omissions).toEqual([omission]);
  });
  it("prefers the most recent equal-quality candidate regardless of input order", () => {
    expect(selectExtractionSnapshot([candidate(3), candidate(0), candidate(1)], () => true).selected_iteration).toBe(3);
  });
  it("excludes final-validation failures rather than normalizing away rejected content", () => {
    const selected = selectExtractionSnapshot([candidate(1), candidate(3)], draft => draft.text !== "V3");
    expect(selected.selected_iteration).toBe(1);
    expect(selected.reason).toContain("1/2 admissible");
  });
  it("throws when every candidate lacks source-supported evidence", () => {
    const failed = candidate(0, { ...clean, risk_level: "check_failed" });
    expect(() => selectExtractionSnapshot([failed], () => true)).toThrow("No admissible extraction snapshot");
  });
  it.each([
    { assessment: clean, missing: [], want: true },
    { assessment: { ...clean, risk_level: "advisory" as const }, missing: [], want: true },
    { assessment: { ...clean, risk_level: "important" as const, suspected_omissions: [omission] }, missing: [], want: true },
    { assessment: { ...clean, suspected_omissions: [omission] }, missing: [], want: true },
    { assessment: clean, missing: ["B2"], want: false },
    { assessment: { ...clean, checked_block_ids: [] }, missing: [], want: false },
    { assessment: { ...clean, unchecked_block_ids: ["B2"] }, missing: [], want: false },
    { assessment: { ...clean, risk_level: "check_failed" as const }, missing: [], want: false },
    { assessment: { ...clean, risk_level: "not_applicable" as const }, missing: [], want: false },
  ])("reports coverage honestly for %j", ({ assessment, missing, want }) => {
    expect(sourceAssessmentChecked(assessment, missing)).toBe(want);
  });
});

it("accepts an empty extraction only with assessed source coverage and final validation", () => {
  const empty = candidate(0);
  empty.signals.quote_validity.valid_count = 0;
  empty.assessment.score = 0;
  empty.assessment.issues = [{ issue_id: "empty", category: "need_extract", code: "no_gaps_proposed",
    severity: "medium", claim: "no_gaps_proposed", suggested_action: "Check the source" }];
  expect(selectExtractionSnapshot([empty], () => true).selected_iteration).toBe(0);
  expect(() => selectExtractionSnapshot([empty], () => false)).toThrow("No admissible extraction snapshot");
});
