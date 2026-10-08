import { describe, expect, it } from "vitest";
import {
  assemblyFingerprint,
  checkAssembly,
  type AssemblyCoverage,
  type ResolvedAssemblyItem,
} from "@/accuracy/domain/assembly";
import type { ParseBlock } from "@/accuracy/store/quote-validator";

const block = (id: string, source_file_id = "source-a", text = "Shared source text supports the selected item."): ParseBlock => ({
  id,
  workspace_id: "workspace-a",
  source_file_id,
  index: 0,
  kind: "prose",
  heading: null,
  text,
});

const gapPayload = (overrides: Record<string, unknown> = {}) => ({
  statement: "Clinicians need clearer discontinuation guidance",
  external_id: "GAP-1",
  provenance: [{ source_file_id: "source-a", block_id: "block-gap", quote: "supports the selected item" }],
  ...overrides,
});

const tacticPayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Publish field guide",
  type: "publication",
  status: "planned",
  evidence_question: "Does a concise guide improve decisions?",
  origin: "inventory",
  provenance: [{ source_file_id: "source-a", block_id: "block-tactic", quote: "supports the selected item" }],
  ...overrides,
});

const item = (
  id: string,
  claim_type: "gap" | "tactic",
  payload: Record<string, unknown>,
  overrides: Partial<ResolvedAssemblyItem> = {},
): ResolvedAssemblyItem => ({
  id,
  claim_id: `${id}-claim`,
  canonical_claim_id: `${id}-canonical`,
  claim_type,
  run_id: `${id}-run`,
  snapshot_id: `${id}-snapshot`,
  iteration: 0,
  item_index: 0,
  payload,
  source_file_id: "source-a",
  created_at: "2026-10-03T00:00:00.000Z",
  reason: `select ${id}`,
  ...overrides,
});

const validSet = () => {
  const gap = item("gap-v0", "gap", gapPayload());
  const tactic = item("tactic-v2", "tactic", tacticPayload());
  const coverage: AssemblyCoverage = {
    run_id: "coverage-run",
    gap_version_id: gap.id,
    tactic_version_id: tactic.id,
    mode: "llm",
    input: {
      gap_id: gap.id,
      tactic_id: tactic.id,
      block_bundle_ids: ["block-gap", "block-tactic"],
      selected_versions: {
        gap_version_id: gap.id,
        tactic_version_id: tactic.id,
        gap_payload: gap.payload,
        tactic_payload: tactic.payload,
      },
    },
    output: {
      gap_id: gap.id,
      tactic_id: tactic.id,
      overall: "partial",
      quote_block_ids: ["block-gap", "block-tactic"],
      confidence: 0.7,
      rationale: "The tactic addresses part of the gap.",
    },
  };
  return {
    items: [gap, tactic],
    blocks: [block("block-gap"), block("block-tactic")],
    mappings: [{ gap_version_id: gap.id, tactic_version_id: tactic.id }],
    coverage: [coverage],
  };
};

const codes = (report: ReturnType<typeof checkAssembly>) => report.findings.map((finding) => finding.code);

describe("assembly domain checks", () => {
  it("passes a valid gap/tactic set, preserves exact ID-less payloads, and treats stub coverage as advisory", () => {
    const set = validSet();
    set.items[0] = item("gap-raw-v0", "gap", gapPayload({ id: undefined }));
    delete set.items[0]!.payload.id;
    set.items[1] = item("tactic-raw-v2", "tactic", tacticPayload({ id: undefined }));
    delete set.items[1]!.payload.id;
    set.mappings = [{ gap_version_id: "gap-raw-v0", tactic_version_id: "tactic-raw-v2" }];
    set.coverage = [{
      ...set.coverage[0]!,
      mode: "stub",
      gap_version_id: "gap-raw-v0",
      tactic_version_id: "tactic-raw-v2",
      input: {
        gap_id: "gap-raw-v0",
        tactic_id: "tactic-raw-v2",
        block_bundle_ids: ["block-gap", "block-tactic"],
        selected_versions: {
          gap_version_id: "gap-raw-v0",
          tactic_version_id: "tactic-raw-v2",
          gap_payload: set.items[0]!.payload,
          tactic_payload: set.items[1]!.payload,
        },
      },
      output: {
        ...(set.coverage[0]!.output as Record<string, unknown>),
        gap_id: "gap-raw-v0",
        tactic_id: "tactic-raw-v2",
      },
    }];

    const before = JSON.stringify(set.items.map((entry) => entry.payload));
    const report = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true });

    expect(report.status).toBe("passed");
    expect(codes(report)).toEqual(["coverage_stub_advisory"]);
    expect(report.findings[0]?.severity).toBe("advisory");
    expect(JSON.stringify(set.items.map((entry) => entry.payload))).toBe(before);
    expect(set.items.map((entry) => entry.payload)).toEqual([gapPayload(), tacticPayload()]);
  });

  it("accepts a legitimate empty complete set", () => {
    expect(checkAssembly({
      items: [],
      source_file_ids: ["source-a"],
      blocks: [],
      mappings: [],
      coverage: [],
      linking_complete: true,
    })).toMatchObject({ status: "passed", findings: [] });
  });

  it("makes fingerprints deterministic, order-sensitive, and independent of object key order", () => {
    const set = validSet();
    const base = assemblyFingerprint({ source_file_ids: ["source-a"], ...set, extraction_runs: null, linking_complete: true });
    const reorderedKeys = assemblyFingerprint({
      source_file_ids: ["source-a"],
      ...set,
      extraction_runs: null,
      items: [{ ...set.items[0]!, payload: { provenance: set.items[0]!.payload.provenance, external_id: "GAP-1", statement: "Clinicians need clearer discontinuation guidance" } }, set.items[1]!],
      linking_complete: true,
    });

    expect(reorderedKeys).toBe(base);
    expect(assemblyFingerprint({ source_file_ids: ["source-a"], ...set, extraction_runs: null, items: [...set.items].reverse(), linking_complete: true })).not.toBe(base);
    expect(assemblyFingerprint({ source_file_ids: ["source-a"], ...set, extraction_runs: null, items: [{ ...set.items[0]!, reason: "new reason" }, set.items[1]!], linking_complete: true })).not.toBe(base);
    expect(assemblyFingerprint({ source_file_ids: ["source-a"], ...set, extraction_runs: null, coverage: [{ ...set.coverage[0]!, run_id: "coverage-run-2" }], linking_complete: true })).not.toBe(base);
    expect(assemblyFingerprint({ source_file_ids: ["source-a"], ...set, extraction_runs: [{ call_kind: "need_extract", run_id: "run", source_file_id: "source-a", item_count: 1, outcome: "items", evaluation_context: "production" }], linking_complete: true })).not.toBe(base);
  });

  it.each([
    ["missing", { source_file_id: "source-a", block_id: "block-gap" }],
    ["null", { source_file_id: "source-a", block_id: "block-gap", quote: null }],
    ["numeric", { source_file_id: "source-a", block_id: "block-gap", quote: 12 }],
  ])("blocks malformed raw %s quote fields without throwing", (_label, provenance) => {
    const set = validSet();
    set.items[0] = item("gap-malformed-quote", "gap", gapPayload({ provenance: [provenance] }));
    set.mappings = [];
    set.coverage = [];

    const report = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true });

    expect(report.status).toBe("blocked");
    expect(codes(report)).toContain("malformed_provenance_span");
  });

  it("blocks evidence borrowed from another selected source for the wrong item origin", () => {
    const set = validSet();
    set.items[0] = item("gap-wrong-origin-evidence", "gap", gapPayload({
      provenance: [{ source_file_id: "source-b", block_id: "block-b", quote: "other source support" }],
    }), { source_file_id: "source-a" });
    set.blocks.push(block("block-b", "source-b", "The other source support is real."));
    set.mappings = [];
    set.coverage = [];

    const report = checkAssembly({ ...set, source_file_ids: ["source-a", "source-b"], linking_complete: true });

    expect(report.status).toBe("blocked");
    expect(codes(report)).toContain("evidence_source_mismatch");
  });

  it("blocks missing required fields, missing quotes, unknown blocks, and wrong source evidence", () => {
    const set = validSet();
    set.items = [
      item("gap-bad", "gap", gapPayload({ statement: "", provenance: [] })),
      item("tactic-bad", "tactic", tacticPayload({
        provenance: [{ source_file_id: "source-b", block_id: "missing-block", quote: "not present" }],
      })),
    ];

    const report = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true });

    expect(report.status).toBe("blocked");
    expect(codes(report)).toEqual(expect.arrayContaining([
      "invalid_gap_payload",
      "missing_provenance",
      "source_out_of_scope",
      "unknown_evidence_block",
    ]));
  });

  it("blocks duplicate version, canonical entry, fingerprint, generated IDs, normalized text, and external IDs", () => {
    const duplicateGap = item("gap-v0", "gap", gapPayload({ id: "generated-gap" }), {
      claim_id: "other-claim",
      canonical_claim_id: "gap-v0-canonical",
    });
    const set = validSet();
    set.items = [
      item("gap-v0", "gap", gapPayload({ id: "generated-gap" })),
      duplicateGap,
      item("gap-v3", "gap", gapPayload({ statement: "Different", external_id: "gap-1" })),
    ];
    set.mappings = [];
    set.coverage = [];

    const report = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true });

    expect(codes(report)).toEqual(expect.arrayContaining([
      "duplicate_version_id",
      "duplicate_canonical_claim",
      "duplicate_generated_fingerprint",
      "duplicate_generated_id",
      "duplicate_gap_statement",
      "duplicate_gap_external_id",
    ]));
  });

  it("blocks duplicate tactic names and generated IDs", () => {
    const set = validSet();
    set.items = [
      item("tactic-v2", "tactic", tacticPayload({ id: "generated-tactic" })),
      item("tactic-v3", "tactic", tacticPayload({ id: "generated-tactic", name: " publish FIELD guide " })),
    ];
    set.mappings = [];
    set.coverage = [];

    expect(codes(checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true }))).toEqual(expect.arrayContaining([
      "duplicate_generated_id",
      "duplicate_tactic_name",
    ]));
  });

  it("blocks invalid mappings, duplicate pairs, unbound or stale coverage, and unsupported evidence", () => {
    const set = validSet();
    set.mappings = [
      { gap_version_id: "missing-gap", tactic_version_id: set.items[1]!.id },
      { gap_version_id: set.items[0]!.id, tactic_version_id: set.items[0]!.id },
      { gap_version_id: set.items[0]!.id, tactic_version_id: set.items[1]!.id },
      { gap_version_id: set.items[0]!.id, tactic_version_id: set.items[1]!.id },
    ];
    set.coverage = [
      { ...set.coverage[0]!, run_id: "unbound", input: {} },
      {
        ...set.coverage[0]!,
        run_id: "stale",
        input: { selected_versions: { gap_version_id: set.items[0]!.id, tactic_version_id: set.items[1]!.id, gap_payload: gapPayload({ statement: "stale" }), tactic_payload: set.items[1]!.payload } },
      },
      {
        ...set.coverage[0]!,
        run_id: "unknown-evidence",
        output: { ...(set.coverage[0]!.output as Record<string, unknown>), quote_block_ids: ["other-block"] },
      },
    ];

    const report = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true });

    expect(codes(report)).toEqual(expect.arrayContaining([
      "mapping_unknown_gap",
      "mapping_wrong_endpoint_type",
      "duplicate_mapping",
      "coverage_version_unbound",
      "coverage_stale_reference",
      "coverage_unknown_evidence_block",
    ]));
  });

  it("blocks coverage input with wrong top-level pair IDs or missing cited blocks in the recorded bundle", () => {
    const set = validSet();
    set.coverage = [
      {
        ...set.coverage[0]!,
        run_id: "wrong-input-pair",
        input: {
          ...set.coverage[0]!.input,
          gap_id: "other-gap-version",
          tactic_id: set.items[1]!.id,
          block_bundle_ids: ["block-gap", "block-tactic"],
        },
        output: {
          ...(set.coverage[0]!.output as Record<string, unknown>),
          gap_id: "other-gap-version",
        },
      },
      {
        ...set.coverage[0]!,
        run_id: "missing-cited-input-block",
        input: {
          ...set.coverage[0]!.input,
          gap_id: set.items[0]!.id,
          tactic_id: set.items[1]!.id,
          block_bundle_ids: ["block-gap"],
        },
      },
    ];

    const report = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true });

    expect(codes(report)).toEqual(expect.arrayContaining([
      "coverage_input_endpoint_mismatch",
      "coverage_quote_not_in_input_bundle",
      "coverage_endpoint_mismatch",
    ]));
  });

  it("blocks coverage outputs with invalid confidence", () => {
    const set = validSet();
    set.coverage = [{
      ...set.coverage[0]!,
      output: {
        ...(set.coverage[0]!.output as Record<string, unknown>),
        confidence: 1.2,
      },
    }];

    expect(codes(checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true }))).toContain("invalid_coverage_output");
  });

  it("blocks supported coverage outputs that cite no verified evidence blocks", () => {
    const set = validSet();
    set.coverage = [{
      ...set.coverage[0]!,
      input: {
        ...set.coverage[0]!.input,
        gap_id: set.items[0]!.id,
        tactic_id: set.items[1]!.id,
        block_bundle_ids: ["block-gap", "block-tactic"],
      },
      output: {
        ...(set.coverage[0]!.output as Record<string, unknown>),
        quote_block_ids: [],
      },
    }];

    const report = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: true });

    expect(codes(report)).toContain("coverage_missing_evidence");
    expect(codes(report)).toContain("mapping_without_supported_coverage");
  });

  it("requires complete pair decisions and keeps not_relevant decisions out of supported mappings", () => {
    const set = validSet();
    const noDecision = checkAssembly({ ...set, coverage: [], source_file_ids: ["source-a"], linking_complete: true });
    const notRelevantWithMapping = checkAssembly({
      ...set,
      source_file_ids: ["source-a"],
      linking_complete: true,
      coverage: [{
        ...set.coverage[0]!,
        output: { ...(set.coverage[0]!.output as Record<string, unknown>), overall: "not_relevant" },
      }],
    });
    const incomplete = checkAssembly({ ...set, source_file_ids: ["source-a"], linking_complete: false });

    expect(codes(noDecision)).toContain("incomplete_linking");
    expect(codes(notRelevantWithMapping)).toContain("mapping_without_supported_coverage");
    expect(codes(incomplete)).toContain("linking_incomplete");
  });
});
