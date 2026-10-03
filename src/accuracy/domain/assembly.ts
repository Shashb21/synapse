import { createHash } from "node:crypto";
import type { Actor } from "@/accuracy/kernel/contracts";
import { generatedItemFingerprint, type ItemVersion } from "@/accuracy/domain/item-history";
import { inventoryTacticSchema } from "@/accuracy/modules/inventory-extract/module";
import { needGapSchema } from "@/accuracy/modules/need-extract/module";
import { coverageDecisionSchema } from "@/accuracy/modules/coverage-decide/schema";
import { validateProvenance, type ParseBlock, type ProvenanceSpan } from "@/accuracy/store/quote-validator";

const CHECKER_VERSION = "assembly-domain-v1";

export type AssemblySelection = { item_version_id: string; reason: string };
export type ResolvedAssemblyItem = ItemVersion & {
  claim_type: "gap" | "tactic";
  canonical_claim_id: string;
  reason: string;
};
export type AssemblyMapping = { gap_version_id: string; tactic_version_id: string };
export type AssemblyCoverage = AssemblyMapping & {
  run_id: string;
  input: Record<string, unknown>;
  output: unknown;
  mode: "llm" | "stub";
};
export type AssemblyExtractionRun = {
  call_kind: "need_extract" | "inventory_extract";
  run_id: string;
  source_file_id: string;
  item_count: number;
  outcome: "items" | "empty";
  evaluation_context?: "production" | "experiment";
};
export type AssemblyCheckReport = {
  checker_version: string;
  status: "passed" | "blocked";
  findings: Array<{
    code: string;
    severity: "blocking" | "advisory";
    item_version_ids: string[];
    message: string;
  }>;
};
export type Assembly = {
  id: string;
  workspace_id: string;
  created_at: string;
  actor: Actor;
  fingerprint: string;
  source_file_ids: string[];
  items: ResolvedAssemblyItem[];
  mappings: AssemblyMapping[];
  coverage: AssemblyCoverage[];
  extraction_runs: AssemblyExtractionRun[] | null;
  linking_complete: boolean;
  generation_key?: string | null;
  output: { gaps: Record<string, unknown>[]; tactics: Record<string, unknown>[] };
  checks: AssemblyCheckReport;
};

export class AssemblyError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "AssemblyError";
  }
}

type Finding = AssemblyCheckReport["findings"][number];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function normalized(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : null;
}

function addFinding(findings: Finding[], code: string, item_version_ids: string[], message: string, severity: Finding["severity"] = "blocking") {
  findings.push({ code, severity, item_version_ids, message });
}

function duplicateFindings(findings: Finding[], code: string, idsByKey: Map<string, string[]>, message: (key: string) => string) {
  for (const [key, ids] of idsByKey) {
    if (ids.length > 1) addFinding(findings, code, ids, message(key));
  }
}

function collectProvenance(payload: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(payload.provenance)
    ? payload.provenance.filter((span): span is Record<string, unknown> => Boolean(span) && typeof span === "object" && !Array.isArray(span))
    : [];
}

function validationPayload(item: ResolvedAssemblyItem): Record<string, unknown> {
  if (typeof item.payload.id === "string" && item.payload.id.trim()) return item.payload;
  return { ...item.payload, id: `assembly-validation:${item.id}` };
}

function validatePayload(item: ResolvedAssemblyItem): boolean {
  return item.claim_type === "gap"
    ? needGapSchema.safeParse(validationPayload(item)).success
    : inventoryTacticSchema.safeParse(validationPayload(item)).success;
}

function addToMap(map: Map<string, string[]>, key: string | null, id: string) {
  if (!key) return;
  map.set(key, [...(map.get(key) ?? []), id]);
}

function coverageSelectedVersions(input: Record<string, unknown>): Record<string, unknown> | null {
  const selected = input.selected_versions;
  return selected && typeof selected === "object" && !Array.isArray(selected)
    ? selected as Record<string, unknown>
    : null;
}

function coverageInputBlockBundle(input: Record<string, unknown>): string[] | null {
  return Array.isArray(input.block_bundle_ids) && input.block_bundle_ids.every((id) => typeof id === "string")
    ? input.block_bundle_ids
    : null;
}

function payloadMatches(a: unknown, b: unknown): boolean {
  return canonicalString(a) === canonicalString(b);
}

/** Build the deterministic content fingerprint for an immutable assembly body. */
export function assemblyFingerprint(args: Pick<Assembly, "source_file_ids" | "items" | "mappings" | "coverage" | "extraction_runs" | "linking_complete">): string {
  return createHash("sha256").update(canonicalString({
    source_file_ids: args.source_file_ids,
    items: args.items,
    mappings: args.mappings,
    coverage: args.coverage,
    extraction_runs: args.extraction_runs,
    linking_complete: args.linking_complete,
  })).digest("hex");
}

/** Run pure whole-set structural checks over resolved versions, parse blocks, mappings, and coverage decisions. */
export function checkAssembly(args: {
  items: ResolvedAssemblyItem[];
  source_file_ids: string[];
  blocks: ParseBlock[];
  mappings: AssemblyMapping[];
  coverage: AssemblyCoverage[];
  linking_complete: boolean;
}): AssemblyCheckReport {
  const findings: Finding[] = [];
  const sourceScope = new Set(args.source_file_ids);
  const blocksById = new Map(args.blocks.map((block) => [block.id, block]));
  const itemsById = new Map<string, ResolvedAssemblyItem>();
  const gaps = new Map<string, ResolvedAssemblyItem>();
  const tactics = new Map<string, ResolvedAssemblyItem>();
  const versionIds = new Map<string, string[]>();
  const canonicalIds = new Map<string, string[]>();
  const fingerprints = new Map<string, string[]>();
  const generatedIds = new Map<string, string[]>();
  const gapStatements = new Map<string, string[]>();
  const gapExternalIds = new Map<string, string[]>();
  const tacticNames = new Map<string, string[]>();

  if (args.source_file_ids.length === 0) {
    addFinding(findings, "empty_source_scope", [], "Assembly source scope must include at least one source file.");
  }

  for (const item of args.items) {
    itemsById.set(item.id, item);
    if (item.claim_type === "gap") gaps.set(item.id, item);
    if (item.claim_type === "tactic") tactics.set(item.id, item);
    addToMap(versionIds, item.id, item.id);
    addToMap(canonicalIds, item.canonical_claim_id, item.id);
    addToMap(fingerprints, generatedItemFingerprint(item.claim_type, item.payload), item.id);
    const generatedId = normalized(item.payload.id);
    if (generatedId) addToMap(generatedIds, `${item.claim_type}:${generatedId}`, item.id);

    if (!item.reason.trim()) {
      addFinding(findings, "missing_selection_reason", [item.id], "Selection reason must be nonempty.");
    }
    if (!sourceScope.has(item.source_file_id)) {
      addFinding(findings, "source_out_of_scope", [item.id], `Item source ${item.source_file_id} is outside the assembly source scope.`);
    }
    if (!validatePayload(item)) {
      addFinding(findings, item.claim_type === "gap" ? "invalid_gap_payload" : "invalid_tactic_payload", [item.id], "Selected item payload does not satisfy the extraction schema.");
    }

    const spans = collectProvenance(item.payload);
    if (spans.length === 0) {
      addFinding(findings, "missing_provenance", [item.id], "Selected item must include at least one provenance span.");
    }
    for (const span of spans) {
      if (typeof span.source_file_id !== "string" || !span.source_file_id.trim()
        || typeof span.block_id !== "string" || !span.block_id.trim()
        || typeof span.quote !== "string") {
        addFinding(findings, "malformed_provenance_span", [item.id], "Evidence provenance must include string source_file_id, block_id, and quote fields.");
        continue;
      }
      const checkedSpan: ProvenanceSpan = { source_file_id: span.source_file_id, block_id: span.block_id, quote: span.quote };
      if (checkedSpan.source_file_id !== item.source_file_id) {
        addFinding(findings, "evidence_source_mismatch", [item.id], `Evidence source ${checkedSpan.source_file_id} does not match selected item source ${item.source_file_id}.`);
      }
      if (!sourceScope.has(checkedSpan.source_file_id)) {
        addFinding(findings, "source_out_of_scope", [item.id], `Evidence source ${checkedSpan.source_file_id} is outside the assembly source scope.`);
      }
      const block = blocksById.get(checkedSpan.block_id);
      if (!block) {
        addFinding(findings, "unknown_evidence_block", [item.id], `Evidence block ${checkedSpan.block_id} is not available for checking.`);
        continue;
      }
      const quote = validateProvenance({ block, span: checkedSpan });
      if (!quote.ok) {
        addFinding(findings, "invalid_evidence_quote", [item.id], `Evidence quote failed validation: ${quote.reason}.`);
      }
    }

    if (item.claim_type === "gap") {
      addToMap(gapStatements, normalized(item.payload.statement), item.id);
      addToMap(gapExternalIds, normalized(item.payload.external_id), item.id);
    } else {
      addToMap(tacticNames, normalized(item.payload.name), item.id);
    }
  }

  duplicateFindings(findings, "duplicate_version_id", versionIds, (key) => `Version ${key} is selected more than once.`);
  duplicateFindings(findings, "duplicate_canonical_claim", canonicalIds, (key) => `Canonical claim ${key} appears more than once.`);
  duplicateFindings(findings, "duplicate_generated_fingerprint", fingerprints, () => "Multiple selected items have the same generated content fingerprint.");
  duplicateFindings(findings, "duplicate_generated_id", generatedIds, () => "Multiple selected items of one type share a generated payload id.");
  duplicateFindings(findings, "duplicate_gap_statement", gapStatements, () => "Multiple selected gaps share the same normalized statement.");
  duplicateFindings(findings, "duplicate_gap_external_id", gapExternalIds, () => "Multiple selected gaps share the same normalized external id.");
  duplicateFindings(findings, "duplicate_tactic_name", tacticNames, () => "Multiple selected tactics share the same normalized name.");

  const mappingPairs = new Map<string, string[]>();
  const selectedMappingPairs = new Set<string>();
  for (const mapping of args.mappings) {
    const ids = [mapping.gap_version_id, mapping.tactic_version_id];
    addToMap(mappingPairs, `${mapping.gap_version_id}\u0000${mapping.tactic_version_id}`, ids.join("|"));
    if (!gaps.has(mapping.gap_version_id)) {
      addFinding(findings, itemsById.has(mapping.gap_version_id) ? "mapping_wrong_endpoint_type" : "mapping_unknown_gap", ids, "Mapping gap endpoint is not a selected gap version.");
    }
    if (!tactics.has(mapping.tactic_version_id)) {
      addFinding(findings, itemsById.has(mapping.tactic_version_id) ? "mapping_wrong_endpoint_type" : "mapping_unknown_tactic", ids, "Mapping tactic endpoint is not a selected tactic version.");
    }
    if (gaps.has(mapping.gap_version_id) && tactics.has(mapping.tactic_version_id)) {
      selectedMappingPairs.add(`${mapping.gap_version_id}\u0000${mapping.tactic_version_id}`);
    }
  }
  for (const [pair, rows] of mappingPairs) {
    if (rows.length > 1) addFinding(findings, "duplicate_mapping", pair.split("\u0000"), "Mapping pair is repeated.");
  }

  const coveragePairs = new Map<string, string[]>();
  const decidedPairs = new Set<string>();
  const supportedCoveragePairs = new Set<string>();
  for (const row of args.coverage) {
    const ids = [row.gap_version_id, row.tactic_version_id];
    const pair = `${row.gap_version_id}\u0000${row.tactic_version_id}`;
    addToMap(coveragePairs, pair, row.run_id);
    if (row.mode === "stub") {
      addFinding(findings, "coverage_stub_advisory", ids, "Stub coverage is recorded as advisory structure only.", "advisory");
    }
    if (!gaps.has(row.gap_version_id)) {
      addFinding(findings, itemsById.has(row.gap_version_id) ? "coverage_wrong_endpoint_type" : "coverage_unknown_gap", ids, "Coverage gap endpoint is not a selected gap version.");
    }
    if (!tactics.has(row.tactic_version_id)) {
      addFinding(findings, itemsById.has(row.tactic_version_id) ? "coverage_wrong_endpoint_type" : "coverage_unknown_tactic", ids, "Coverage tactic endpoint is not a selected tactic version.");
    }

    const inputVersions = coverageSelectedVersions(row.input);
    if (!inputVersions
      || inputVersions.gap_version_id !== row.gap_version_id
      || inputVersions.tactic_version_id !== row.tactic_version_id
      || !("gap_payload" in inputVersions)
      || !("tactic_payload" in inputVersions)) {
      addFinding(findings, "coverage_version_unbound", ids, "Coverage input does not bind exact selected versions and payloads.");
    } else {
      const gap = gaps.get(row.gap_version_id);
      const tactic = tactics.get(row.tactic_version_id);
      if ((gap && !payloadMatches(inputVersions.gap_payload, gap.payload))
        || (tactic && !payloadMatches(inputVersions.tactic_payload, tactic.payload))) {
        addFinding(findings, "coverage_stale_reference", ids, "Coverage input payload differs from selected version payload.");
      }
    }
    if (row.input.gap_id !== row.gap_version_id || row.input.tactic_id !== row.tactic_version_id) {
      addFinding(findings, "coverage_input_endpoint_mismatch", ids, "Coverage input pair IDs do not match selected version endpoints.");
    }

    const parsed = coverageDecisionSchema.safeParse(row.output);
    if (!parsed.success) {
      addFinding(findings, "invalid_coverage_output", ids, "Coverage output does not satisfy the decision schema.");
      continue;
    }
    if (parsed.data.gap_id !== row.gap_version_id || parsed.data.tactic_id !== row.tactic_version_id) {
      addFinding(findings, "coverage_endpoint_mismatch", ids, "Coverage output IDs do not match selected version endpoints.");
    }
    decidedPairs.add(pair);

    const allowedBlocks = new Set([
      ...collectProvenance(gaps.get(row.gap_version_id)?.payload ?? {}).flatMap((span) => typeof span.block_id === "string" ? [span.block_id] : []),
      ...collectProvenance(tactics.get(row.tactic_version_id)?.payload ?? {}).flatMap((span) => typeof span.block_id === "string" ? [span.block_id] : []),
    ]);
    const inputBlockBundle = coverageInputBlockBundle(row.input);
    if (!inputBlockBundle) {
      addFinding(findings, "coverage_input_block_bundle_unbound", ids, "Coverage input does not record the exact block bundle used for the decision.");
    } else {
      for (const blockId of inputBlockBundle) {
        if (!allowedBlocks.has(blockId) || !blocksById.has(blockId)) {
          addFinding(findings, "coverage_input_unknown_evidence_block", ids, `Coverage input block bundle includes ${blockId}, which is not in the selected pair evidence bundle.`);
        }
      }
    }
    let verifiedEvidenceCount = 0;
    for (const blockId of parsed.data.quote_block_ids) {
      if (!allowedBlocks.has(blockId) || !blocksById.has(blockId)) {
        addFinding(findings, "coverage_unknown_evidence_block", ids, `Coverage cites block ${blockId}, which is not in the selected pair evidence bundle.`);
        continue;
      }
      if (!inputBlockBundle?.includes(blockId)) {
        addFinding(findings, "coverage_quote_not_in_input_bundle", ids, `Coverage cites block ${blockId}, which was not recorded in the input block bundle.`);
        continue;
      }
      verifiedEvidenceCount += 1;
    }
    if (parsed.data.overall === "full" || parsed.data.overall === "partial" || parsed.data.overall === "limited") {
      if (verifiedEvidenceCount === 0) {
        addFinding(findings, "coverage_missing_evidence", ids, "Supported coverage decisions must cite at least one verified selected-pair evidence block.");
      } else {
        supportedCoveragePairs.add(pair);
      }
    }
  }
  for (const [pair, rows] of coveragePairs) {
    if (rows.length > 1) addFinding(findings, "duplicate_coverage_decision", pair.split("\u0000"), "Coverage decision pair is repeated.");
  }

  for (const pair of supportedCoveragePairs) {
    if (!selectedMappingPairs.has(pair)) {
      addFinding(findings, "supported_coverage_without_mapping", pair.split("\u0000"), "Supported coverage decision must have a matching assembly mapping.");
    }
  }
  for (const pair of selectedMappingPairs) {
    if (!supportedCoveragePairs.has(pair)) {
      addFinding(findings, "mapping_without_supported_coverage", pair.split("\u0000"), "Assembly mapping must have a full, partial, or limited coverage decision.");
    }
  }

  if (!args.linking_complete) {
    addFinding(findings, "linking_incomplete", [], "Assembly linking has not completed.");
  } else {
    for (const gapId of gaps.keys()) {
      for (const tacticId of tactics.keys()) {
        const pair = `${gapId}\u0000${tacticId}`;
        if (!decidedPairs.has(pair)) {
          addFinding(findings, "incomplete_linking", [gapId, tacticId], "Complete linking requires one recorded decision for each selected gap/tactic pair.");
        }
      }
    }
  }

  return {
    checker_version: CHECKER_VERSION,
    status: findings.some((finding) => finding.severity === "blocking") ? "blocked" : "passed",
    findings,
  };
}
