/** Tests for source-grounded snapshot completeness inspection. */
import { describe, expect, it } from "vitest";
import type { JsonCompletion } from "@/accuracy/kernel/contracts";
import { inspectSnapshotCompleteness, type SuspectedOmission } from "@/accuracy/modules/completeness-audit/snapshot-inspector";

const blocks = [
  { id: "a", source_file_id: "source", index: 0, kind: "prose", text: "A registry tracks outcomes in older patients after treatment." },
  { id: "b", source_file_id: "source", index: 1, kind: "prose", text: "Comparative effectiveness remains unknown in elderly patients. A pragmatic trial is planned." },
];
const items = [{ item_kind: "gap" as const, item_ref: "gap-a", statement: "Registry evidence is needed", provenance: [{ source_file_id: "source", block_id: "a", quote: blocks[0].text }, { source_file_id: "source", block_id: "b", quote: "Comparative effectiveness remains unknown" }] }];
const finding = { item_kind: "gap", summary: "Comparative effectiveness in elderly patients", source_ref: { source_file_id: "source", block_id: "b" }, evidence_quote: "Comparative effectiveness remains unknown in elderly patients.", basis: "explicit", reason: "Current gap only covers registry outcomes", suggested_action: "Add a comparative effectiveness gap" } as const;
const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function completion(response: Record<string, unknown>, onPrompt?: (prompt: string) => void, includeCoverage = true): JsonCompletion {
  return async ({ user }) => {
    onPrompt?.(user);
    return { raw: JSON.stringify(includeCoverage ? { checked_block_ids: ["a", "b"], ...response } : response), usage };
  };
}

describe("snapshot completeness inspector", () => {
  it("inspects every supplied block and item even when an item cites both blocks", async () => {
    let prompt = "";
    const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [], complete: completion({ suspected_omissions: [finding], prior_issue_resolutions: [] }, (text) => { prompt = text; }) });
    expect(prompt).toContain(blocks[0].text);
    expect(prompt).toContain(blocks[1].text);
    expect(prompt).toContain(items[0].statement);
    expect(prompt).toContain(items[0].item_ref);
    expect(result.checked_block_ids).toEqual(["a", "b"]);
    expect(result).toMatchObject({ risk_level: "important", unchecked_block_ids: [], suspected_omissions: [{ item_kind: "gap", source_ref: { source_file_id: "source", block_id: "b" }, evidence_quote: finding.evidence_quote, basis: "explicit", importance: "important" }] });
    expect(result.suspected_omissions[0].issue_id).toBeTruthy();
  });

  it("normalizes inferred findings to advisory and keeps distinct findings from one block", async () => {
    const second = { ...finding, item_kind: "tactic", summary: "Pragmatic trial", evidence_quote: "A pragmatic trial is planned.", basis: "inferred" };
    const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [], complete: completion({ suspected_omissions: [finding, second], prior_issue_resolutions: [] }) });
    expect(result.suspected_omissions).toHaveLength(2);
    expect(new Set(result.suspected_omissions.map((issue) => issue.issue_id)).size).toBe(2);
    expect(result.suspected_omissions[1]).toMatchObject({ basis: "inferred", importance: "advisory" });
  });

  it("keeps same-quote safety and survival gaps independent when only safety is resolved", async () => {
    const quote = "Safety and survival evidence are missing in elderly patients.";
    const source = [{ ...blocks[1], text: quote }];
    const safety = { ...finding, summary: "Safety evidence", evidence_quote: quote };
    const survival = { ...finding, summary: "Survival evidence", evidence_quote: quote };
    const v0 = await inspectSnapshotCompleteness({ blocks: source, items: [], prior_open_issues: [],
      complete: completion({ checked_block_ids: ["b"], suspected_omissions: [safety, survival], prior_issue_resolutions: [] }) });
    expect(v0.suspected_omissions).toHaveLength(2);
    const [safetyIssue, survivalIssue] = v0.suspected_omissions;
    expect(safetyIssue.issue_id).not.toBe(survivalIssue.issue_id);

    const v1 = await inspectSnapshotCompleteness({ blocks: source,
      items: [{ item_kind: "gap", item_ref: "safety-gap", statement: "Safety evidence", provenance: [] }],
      prior_open_issues: v0.suspected_omissions,
      complete: completion({ checked_block_ids: ["b"], suspected_omissions: [survival], prior_issue_resolutions: [
        { issue_id: safetyIssue.issue_id, outcome: "resolved", reason: "Safety gap added", matched_item_ref: "safety-gap" },
      ] }) });
    expect(v1.suspected_omissions).toEqual([survivalIssue]);
    expect(v1.prior_issue_resolutions).toEqual([
      expect.objectContaining({ issue_id: safetyIssue.issue_id, outcome: "resolved" }),
      expect.objectContaining({ issue_id: survivalIssue.issue_id, outcome: "unresolved" }),
    ]);
    expect(v1.risk_level).toBe("important");
  });

  it("conservatively retains the prior issue when a finding changes wording despite a supplied ID", async () => {
    const prior: SuspectedOmission = { ...finding, issue_id: "legacy-issue", importance: "important" };
    const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [prior],
      complete: completion({ suspected_omissions: [{ ...finding, summary: "Reworded comparative evidence need",
        evidence_quote: "Comparative effectiveness remains unknown", prior_issue_id: prior.issue_id }], prior_issue_resolutions: [] }) });
    expect(result.suspected_omissions).toHaveLength(2);
    expect(result.suspected_omissions[0]).toEqual(prior);
    expect(result.suspected_omissions[1]).toMatchObject({ summary: "Reworded comparative evidence need", importance: "important" });
    expect(result.suspected_omissions[1].issue_id).not.toBe(prior.issue_id);
    expect(result.prior_issue_resolutions[0]).toMatchObject({ issue_id: "legacy-issue", outcome: "unresolved" });
    expect(result.risk_level).toBe("important");
  });

  it("keeps new survival risk when a supplied prior ID points to resolved safety in the same block", async () => {
    const quote = "Safety and survival evidence are missing in elderly patients.";
    const source = [{ ...blocks[1], text: quote }];
    const safety = { ...finding, summary: "Safety evidence", evidence_quote: quote };
    const v0 = await inspectSnapshotCompleteness({ blocks: source, items: [], prior_open_issues: [],
      complete: completion({ checked_block_ids: ["b"], suspected_omissions: [safety], prior_issue_resolutions: [] }) });
    const safetyIssue = v0.suspected_omissions[0];
    const v1 = await inspectSnapshotCompleteness({ blocks: source,
      items: [{ item_kind: "gap", item_ref: "safety-gap", statement: "Safety evidence", provenance: [] }],
      prior_open_issues: v0.suspected_omissions,
      complete: completion({ checked_block_ids: ["b"], suspected_omissions: [
        { ...finding, summary: "Survival evidence", evidence_quote: quote, prior_issue_id: safetyIssue.issue_id },
      ], prior_issue_resolutions: [
        { issue_id: safetyIssue.issue_id, outcome: "resolved", reason: "Safety gap added", matched_item_ref: "safety-gap" },
      ] }) });
    expect(v1.suspected_omissions).toHaveLength(1);
    expect(v1.suspected_omissions[0]).toMatchObject({ summary: "Survival evidence", importance: "important" });
    expect(v1.suspected_omissions[0].issue_id).not.toBe(safetyIssue.issue_id);
    expect(v1.prior_issue_resolutions[0]).toMatchObject({ issue_id: safetyIssue.issue_id, outcome: "resolved" });
    expect(v1.risk_level).toBe("important");
  });

  it("does not give a new same-quote finding the ID of a closed persisted issue", async () => {
    const first = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [],
      complete: completion({ suspected_omissions: [finding], prior_issue_resolutions: [] }) });
    const prior = first.suspected_omissions[0];
    const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [prior],
      complete: completion({ suspected_omissions: [{ ...finding, summary: "A distinct gap supported by the same quote" }],
        prior_issue_resolutions: [{ issue_id: prior.issue_id, outcome: "resolved", reason: "Added", matched_item_ref: "gap-a" }] }) });
    expect(result.suspected_omissions).toHaveLength(1);
    expect(result.suspected_omissions[0].issue_id).not.toBe(prior.issue_id);
    expect(result.risk_level).toBe("important");
  });

  it("rejects a quote that is not verbatim or points outside selected source scope", async () => {
    for (const bad of [
      { ...finding, evidence_quote: "Comparative effectiveness is known" },
      { ...finding, source_ref: { source_file_id: "other", block_id: "b" } },
      { ...finding, source_ref: { source_file_id: "source", block_id: "missing" } },
    ]) {
      const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [], complete: completion({ suspected_omissions: [bad], prior_issue_resolutions: [] }) });
      expect(result.risk_level).toBe("check_failed");
      expect(result.suspected_omissions).toEqual([]);
      expect(result.unchecked_block_ids).toEqual(["a", "b"]);
    }
  });

  it("retains prior IDs and accepts only explicit valid lifecycle dispositions", async () => {
    const prior: SuspectedOmission = { ...finding, issue_id: "issue-old", importance: "important" };
    const valid = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [prior], complete: completion({ suspected_omissions: [], prior_issue_resolutions: [{ issue_id: "issue-old", outcome: "resolved", reason: "Captured in the current gap", matched_item_ref: "gap-a" }] }) });
    expect(valid.prior_issue_resolutions).toEqual([{ issue_id: "issue-old", outcome: "resolved", reason: "Captured in the current gap", matched_item_ref: "gap-a" }]);
    expect(valid.suspected_omissions).toEqual([]);

    for (const disposition of [undefined, { issue_id: "issue-old", outcome: "resolved", reason: "" }, { issue_id: "issue-old", outcome: "resolved", reason: "Captured", matched_item_ref: "nonexistent" }]) {
      const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [prior], complete: completion({ suspected_omissions: [], prior_issue_resolutions: disposition ? [disposition] : [] }) });
      expect(result.prior_issue_resolutions).toEqual([{ issue_id: "issue-old", outcome: "unresolved", reason: expect.any(String) }]);
      expect(result.suspected_omissions).toEqual([prior]);
      expect(result.risk_level).toBe("important");
    }
  });

  it("does not reopen a resolved prior issue when the model repeats its evidence", async () => {
    const prior: SuspectedOmission = { ...finding, issue_id: "issue-old", importance: "important" };
    const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [prior], complete: completion({ suspected_omissions: [finding], prior_issue_resolutions: [{ issue_id: "issue-old", outcome: "resolved", reason: "Covered by gap-a", matched_item_ref: "gap-a" }] }) });
    expect(result.suspected_omissions).toEqual([]);
    expect(result.risk_level).toBe("none_detected");
  });

  it("reports provider and parse failures as check_failed while retaining prior evidence", async () => {
    const prior: SuspectedOmission = { ...finding, issue_id: "issue-old", importance: "important" };
    const broken: JsonCompletion[] = [async () => { throw new Error("provider down"); }, async () => ({ raw: "not json", usage })];
    for (const complete of broken) {
      const result = await inspectSnapshotCompleteness({ blocks, items, prior_open_issues: [prior], complete });
      expect(result).toMatchObject({ risk_level: "check_failed", checked_block_ids: [], unchecked_block_ids: ["a", "b"], suspected_omissions: [prior] });
      expect(result.prior_issue_resolutions).toEqual([{ issue_id: "issue-old", outcome: "unresolved", reason: expect.any(String) }]);
    }
  });

  it("does not report no risk when the model omits its checked-block declaration", async () => {
    const result = await inspectSnapshotCompleteness({
      blocks,
      items,
      prior_open_issues: [],
      complete: completion({ suspected_omissions: [], prior_issue_resolutions: [] }, undefined, false),
    });
    expect(result).toMatchObject({
      risk_level: "check_failed",
      checked_block_ids: [],
      unchecked_block_ids: ["a", "b"],
      suspected_omissions: [],
    });
  });
});
