/** Bind source-derived consumer inputs before opening a production run. */
import { resolveGapStatus, resolvePriorityBand } from "../domain/iegp-semantics";
import type { CallKind } from "./contracts";
import type { ApprovedLiveInventory } from "../store/assembly-review-store";
import { AssemblyReviewError } from "../domain/assembly-review";
import { asTacticLifecycle, normalizeCoverageOverall } from "../modules/status-derive/engine";
import { claimMetadata, gapsForGantt, tacticsForGantt } from "../store/claim-store";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : null;
}

function provenanceBlockIds(payload: Record<string, unknown>): string[] {
  const spans = Array.isArray(payload.provenance) ? payload.provenance : [];
  return [...new Set(spans.flatMap((span) => {
    const row = record(span);
    const block = row?.block_id;
    return typeof block === "string" && block.trim() ? [block] : [];
  }))];
}

function coverageBlockBundle(row: ApprovedLiveInventory["coverage"][number] | undefined): string[] {
  const dimensions = record(row?.dimensions);
  return stringArray(dimensions?.block_bundle_ids) ?? stringArray(dimensions?.quote_block_ids) ?? [];
}

export async function resolveApprovedRunInput<I>(args: {
  workspace_id: string;
  call_kind: CallKind;
  input: I;
  live: ApprovedLiveInventory | null;
}): Promise<I> {
  if (!args.live) return args.input;
  if (args.call_kind === "coverage_decide") return resolveCoverageDecideInput(args.input, args.live) as I;
  if (args.call_kind === "ideate") return resolveIdeateInput(args.input, args.live) as I;
  if (args.call_kind === "gantt_project") return resolveGanttInput(args.input, args.live) as I;
  if (args.call_kind === "status_derive") {
    validateStatusDeriveInput(args.input, args.live);
  }
  return args.input;
}

function resolveCoverageDecideInput(input: unknown, live: ApprovedLiveInventory): unknown {
  const data = record(input);
  if (!data) return input;
  const gapId = typeof data.gap_id === "string" ? data.gap_id : "";
  const tacticId = typeof data.tactic_id === "string" ? data.tactic_id : "";
  const gap = live.selected_items.find((item) => item.claim_id === gapId && item.claim_type === "gap");
  const tactic = live.selected_items.find((item) => item.claim_id === tacticId && item.claim_type === "tactic");
  if (!gap || !tactic) {
    throw new AssemblyReviewError("approval_required", "Coverage decision requires claims from the current approved assembly.");
  }
  const selected_versions = {
    gap_version_id: gap.item_version_id,
    tactic_version_id: tactic.item_version_id,
    gap_payload: gap.payload,
    tactic_payload: tactic.payload,
  };
  if (data.selected_versions !== undefined && !sameJson(data.selected_versions, selected_versions)) {
    throw new AssemblyReviewError("conflict", "Supplied selected versions differ from the current approved assembly.");
  }
  const coverage = live.coverage.find((row) => row.gap_id === gapId && row.tactic_id === tacticId);
  const approvedBundle = coverageBlockBundle(coverage);
  const resolvedBundle = approvedBundle.length > 0 ? approvedBundle : [...new Set([
    ...provenanceBlockIds(gap.payload),
    ...provenanceBlockIds(tactic.payload),
  ])];
  const suppliedBundle = stringArray(data.block_bundle_ids) ?? [];
  if (!sameJson(suppliedBundle, resolvedBundle)) {
    throw new AssemblyReviewError("conflict", "Supplied coverage evidence bundle differs from the current approved assembly.");
  }
  return { ...data, block_bundle_ids: resolvedBundle, selected_versions };
}

function validateStatusDeriveInput(input: unknown, live: ApprovedLiveInventory): void {
  const data = record(input);
  if (!data) return;
  const gapIds = new Set(live.claims.filter(claim => claim.claim_type === "gap").map(claim => claim.id));
  for (const id of stringArray(data.gap_ids) ?? []) if (!gapIds.has(id)) inputConflict();
  const tactics = live.claims.filter(claim => claim.claim_type === "tactic").flatMap(claim => {
    const status = asTacticLifecycle(claimMetadata(claim).tactic_status) ?? asTacticLifecycle(claim.status);
    return status ? [{ id: claim.id, status }] : [];
  });
  // gap_ids selects computations; supplied evidence must represent the complete inventory.
  if (data.tactics !== undefined && !sameMembers(data.tactics as unknown[], tactics)) inputConflict();
  if (data.coverages !== undefined) {
    const supplied = (data.coverages as unknown[]).map(value => {
      const row = record(value);
      return { ...row, overall: normalizeCoverageOverall(String(row?.overall ?? "")) ?? "not_relevant" };
    });
    if (!sameMembers(supplied, coverageInputs(live))) inputConflict();
  }
}

function inputConflict(): never {
  throw new AssemblyReviewError("conflict", "Supplied source inputs differ from the current approved assembly.");
}

function sameMembers(actual: unknown[], expected: unknown[]): boolean {
  return sameJson(actual.map(canonical).map(value => JSON.stringify(value)).sort(),
    expected.map(canonical).map(value => JSON.stringify(value)).sort());
}

function coverageInputs(live: ApprovedLiveInventory) {
  return live.coverage.map(row => ({ gap_id: row.gap_id, tactic_id: row.tactic_id,
    overall: normalizeCoverageOverall(row.overall) ?? "not_relevant", validated: row.validated }));
}

function resolveGanttInput(input: unknown, live: ApprovedLiveInventory): unknown {
  const data = record(input);
  if (!data) return input;
  const approvedTactics = tacticsForGantt(live.claims);
  const supplied = Array.isArray(data.tactics) ? data.tactics.map(record) : [];
  if (!sameMembers(supplied.map(row => row?.id), approvedTactics.map(row => row.id))) inputConflict();
  const tactics = approvedTactics.map(approved => {
    const row = supplied.find(row => row?.id === approved.id)!;
    if (row.validated !== approved.validated) inputConflict();
    for (const key of ["depends_on", "gap_ids"] as const) {
      if (row[key] !== undefined && !sameMembers(stringArray(row[key]) ?? [], approved[key])) inputConflict();
    }
    if (row.tactic_type !== undefined && row.tactic_type !== approved.tactic_type) inputConflict();
    // Dates are explicit scheduling workflow inputs; membership and relationships are immutable.
    return { ...approved, ...Object.fromEntries(["start", "end", "readout"]
      .filter(key => row[key] !== undefined).map(key => [key, row[key]])) };
  });
  const gaps = gapsForGantt(live.claims);
  if (data.gaps !== undefined) {
    const suppliedGaps = (data.gaps as unknown[]).map(record);
    if (!sameMembers(suppliedGaps.map(row => row?.id), gaps.map(row => row.id))) inputConflict();
    for (const row of suppliedGaps) {
      const approved = gaps.find(gap => gap.id === row?.id)!;
      if (row?.parent_gap_id !== undefined && row.parent_gap_id !== approved.parent_gap_id) inputConflict();
      if (row?.validated !== undefined && row.validated !== approved.validated) inputConflict();
    }
  }
  const coverages = coverageInputs(live);
  if (data.coverages !== undefined && !sameMembers(data.coverages as unknown[], coverages)) inputConflict();
  for (const row of (Array.isArray(data.activities) ? data.activities : []).map(record)) {
    const approved = approvedTactics.find(tactic => tactic.id === row?.tactic_id);
    if (!approved || !row) inputConflict();
    if (row.id !== undefined && row.id !== `ACT-${approved.id}`) inputConflict();
    if (row.depends_on !== undefined && !sameMembers(
      (stringArray(row.depends_on) ?? []).map(id => id.replace(/^ACT-/, "")),
      approved.depends_on.map(id => id.replace(/^ACT-/, "")))) inputConflict();
  }
  return { ...data, tactics, gaps, coverages };
}

function resolveIdeateInput(input: unknown, live: ApprovedLiveInventory): unknown {
  const data = record(input);
  if (!data) return input;
  const gaps = (Array.isArray(data.gaps) ? data.gaps : []).map(value => {
    const row = record(value);
    const approved = live.claims.find(claim => claim.claim_type === "gap" && claim.id === row?.id);
    if (!approved || !row) inputConflict();
    const meta = claimMetadata(approved);
    const resolved = { id: approved.id, statement: approved.statement, status: resolveGapStatus(approved.status),
      priority_band: resolvePriorityBand(meta.priority ?? meta.priority_band), validated: approved.validated };
    if (!sameJson({ ...row, validated: row.validated ?? resolved.validated }, resolved)) inputConflict();
    return resolved;
  });
  if (new Set(gaps.map(row => row.id)).size !== gaps.length) inputConflict();
  const names = live.claims.filter(claim => claim.claim_type === "tactic").map(claim => claim.statement);
  if (!sameMembers(stringArray(data.existing_tactic_names) ?? [], names)) inputConflict();
  // Gap selection, hints and per_gap remain workflow options; eligibility and library names do not.
  return { ...data, gaps, existing_tactic_names: names };
}
