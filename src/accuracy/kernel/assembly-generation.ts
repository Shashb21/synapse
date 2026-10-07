/** Automatic assembly selection and version-bound pairwise linking for completed extraction batches. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@/accuracy/kernel/contracts";
import { runAccuracyModule, type AccuracyRunResult } from "@/accuracy/kernel/run";
import { generatedItemFingerprint } from "@/accuracy/domain/item-history";
import type { Assembly, AssemblyMapping, AssemblySelection, ResolvedAssemblyItem } from "@/accuracy/domain/assembly";
import { AssemblyError } from "@/accuracy/domain/assembly";
import type { AssemblyExtractionRun } from "@/accuracy/domain/assembly";
import type { CoverageDecision } from "@/accuracy/modules/coverage-decide/schema";
import { createAssembly, resolveAssemblyItems } from "@/accuracy/store/assembly-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";

type ExtractionKind = "gap" | "tactic";
type RunRow = typeof t.accuracyModuleRuns.$inferSelect;
type VersionRow = typeof t.accuracyItemVersions.$inferSelect;
type EventRow = typeof t.accuracyAgentEvents.$inferSelect;
type EvaluationContext = "production" | "experiment";

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

function finalItems(row: RunRow): { kind: ExtractionKind; items: Record<string, unknown>[] } {
  const kind = row.call_kind === "need_extract" ? "gap" : row.call_kind === "inventory_extract" ? "tactic" : null;
  if (!kind) throw new AssemblyError("invalid_input", "Assembly generation only accepts extraction runs.");
  if (row.status !== "ok") throw new AssemblyError("invalid_input", "Assembly generation requires successful extraction runs.");
  const output = row.output as Record<string, unknown> | null;
  const key = kind === "gap" ? "gaps" : "tactics";
  const items = output?.[key];
  if (!Array.isArray(items)) throw new AssemblyError("invalid_input", "Extraction run output is missing generated items.");
  return { kind, items: items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) };
}

function selectedIteration(events: EventRow[], run_id: string): number | null {
  const judgment = events.find((event) => event.run_id === run_id && event.event_type === "judgment");
  const payload = judgment?.payload as Record<string, unknown> | undefined;
  return typeof payload?.selected_iteration === "number" ? payload.selected_iteration : null;
}

function originLabel(row: VersionRow): string {
  return row.snapshot_id ? `snapshot iteration ${row.iteration}` : "judged final output";
}

function chooseVersion(args: {
  run: RunRow;
  kind: ExtractionKind;
  item: Record<string, unknown>;
  item_index: number;
  versions: VersionRow[];
  events: EventRow[];
}): VersionRow {
  const fingerprint = generatedItemFingerprint(args.kind, args.item);
  const candidates = args.versions.filter((row) => row.run_id === args.run.id && row.claim_type === args.kind
    && row.fingerprint === fingerprint);
  if (candidates.length === 0) {
    throw new AssemblyError("not_found", "No persisted item version matches the judged extraction output.");
  }
  const exact = candidates.filter((row) => sameJson(row.payload, args.item));
  if (exact.length === 0) {
    throw new AssemblyError("not_found", "No persisted item version exactly matches the judged extraction output.");
  }
  const selected = selectedIteration(args.events, args.run.id);
  const tieBreak = (rows: VersionRow[]) => [...rows].sort((a, b) =>
    a.item_index - b.item_index
    || (a.iteration ?? Number.MAX_SAFE_INTEGER) - (b.iteration ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id));
  const tiers = [
    exact.filter((row) => row.snapshot_id && row.iteration === selected && row.item_index === args.item_index),
    exact.filter((row) => row.snapshot_id && row.iteration === selected),
    exact.filter((row) => !row.snapshot_id && row.item_index === args.item_index),
    exact.filter((row) => !row.snapshot_id),
    exact.filter((row) => row.item_index === args.item_index),
    exact,
  ];
  for (const tier of tiers) {
    const unique = [...new Map(tier.map((row) => [row.id, row])).values()];
    if (unique.length) return tieBreak(unique)[0]!;
  }
  throw new AssemblyError("not_found", "No persisted item version exactly matches the judged extraction output.");
}

function evidenceBlockIds(...items: ResolvedAssemblyItem[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const spans = Array.isArray(item.payload.provenance) ? item.payload.provenance : [];
    for (const span of spans) {
      if (!span || typeof span !== "object" || Array.isArray(span)) continue;
      const blockId = (span as Record<string, unknown>).block_id;
      if (typeof blockId !== "string" || !blockId.trim() || seen.has(blockId)) continue;
      seen.add(blockId);
      ids.push(blockId);
    }
  }
  return ids;
}

function reservedCoverageRunId(generation_key: string, gap_version_id: string, tactic_version_id: string): string {
  const hash = createHash("sha256").update(`${generation_key}\u0000${gap_version_id}\u0000${tactic_version_id}`).digest("hex");
  return `arun_asm_${hash.slice(0, 40)}`;
}

function coverageAttemptRunId(base: string, attempt: number): string {
  return attempt === 0 ? base : `${base}_retry_${attempt}`;
}

async function runCoverageDecision(args: {
  base_run_id: string;
  input: Record<string, unknown>;
  actor: Actor;
  org_id: string;
  workspace_id: string;
  evaluation_context: EvaluationContext;
}): Promise<AccuracyRunResult<CoverageDecision>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reserved_run_id = coverageAttemptRunId(args.base_run_id, attempt);
    const [existing] = await accuracyDb().select().from(t.accuracyModuleRuns).where(and(
      eq(t.accuracyModuleRuns.workspace_id, args.workspace_id),
      eq(t.accuracyModuleRuns.id, reserved_run_id),
    )).limit(1);
    if (existing) {
      if (existing.call_kind !== "coverage_decide" || existing.org_id !== args.org_id || existing.evaluation_context !== args.evaluation_context
        || !isDeepStrictEqual(existing.input, args.input)) {
        throw new AssemblyError("conflict", "Reserved coverage run identity conflicts with this operation.");
      }
      if (existing.status === "ok") {
        return runAccuracyModule<CoverageDecision>({
          call_kind: "coverage_decide",
          agent_role: "proposer",
          input: args.input,
          actor: args.actor,
          org_id: args.org_id,
          workspace_id: args.workspace_id,
          reserved_run_id,
          evaluation_context: args.evaluation_context,
        });
      }
      if (existing.status === "running") {
        throw new AssemblyError("conflict", "Reserved coverage run is still in progress.");
      }
      continue;
    }
    return runAccuracyModule<CoverageDecision>({
      call_kind: "coverage_decide",
      agent_role: "proposer",
      input: args.input,
      actor: args.actor,
      org_id: args.org_id,
      workspace_id: args.workspace_id,
      reserved_run_id,
      evaluation_context: args.evaluation_context,
    });
  }
  throw new AssemblyError("conflict", "Coverage retry attempts are exhausted.");
}

function sourceIdsFromRuns(rows: RunRow[]): string[] {
  return [...new Set(rows.flatMap((row) => {
    const source = (row.input as Record<string, unknown> | null)?.source_file_id;
    return typeof source === "string" ? [source] : [];
  }))];
}

function extractionRunScope(rows: RunRow[]): AssemblyExtractionRun[] {
  return rows.map((row) => {
    const { kind, items } = finalItems(row);
    const input = row.input as Record<string, unknown>;
    return {
      call_kind: kind === "gap" ? "need_extract" : "inventory_extract",
      run_id: row.id,
      source_file_id: input.source_file_id as string,
      item_count: items.length,
      outcome: items.length > 0 ? "items" : "empty",
      evaluation_context: row.evaluation_context === "experiment" ? "experiment" : "production",
    };
  });
}

/** Create or retrieve the immutable assembly for one applied extraction publication. */
export async function generateExtractionAssembly(args: {
  workspace_id: string;
  org_id: string;
  actor: Actor;
  source_file_ids: string[];
  extraction_run_ids: string[];
  generation_key: string;
  requested_kinds?: Array<"need_extract" | "inventory_extract">;
  evaluation_context?: EvaluationContext;
}): Promise<Assembly> {
  await ensureAccuracySchema();
  const evaluation_context = args.evaluation_context ?? "production";
  const runIds = args.extraction_run_ids.filter((id) => id.trim());
  if (runIds.length !== args.extraction_run_ids.length || new Set(runIds).size !== runIds.length) {
    throw new AssemblyError("invalid_input", "Extraction run IDs must be distinct nonempty IDs.");
  }
  if (!args.generation_key.trim()) throw new AssemblyError("invalid_input", "Generation key is required.");

  const runs = runIds.length === 0 ? [] : await accuracyDb().select().from(t.accuracyModuleRuns)
    .where(and(eq(t.accuracyModuleRuns.workspace_id, args.workspace_id), inArray(t.accuracyModuleRuns.id, runIds)))
    .orderBy(asc(t.accuracyModuleRuns.started_at), asc(t.accuracyModuleRuns.id));
  if (runs.length !== runIds.length) throw new AssemblyError("not_found", "An extraction run is outside this workspace.");
  const runsById = new Map(runs.map((row) => [row.id, row]));
  const orderedRuns = runIds.map((id) => runsById.get(id)!);
  for (const run of orderedRuns) {
    if (run.org_id !== args.org_id) throw new AssemblyError("not_found", "An extraction run is outside this organization.");
    if (run.evaluation_context !== evaluation_context) throw new AssemblyError("invalid_input", "Extraction run evaluation context does not match assembly generation.");
    const input = run.input as Record<string, unknown> | null;
    if (input?.workspace_id !== args.workspace_id || typeof input.source_file_id !== "string") {
      throw new AssemblyError("invalid_input", "Extraction run input is not bound to this workspace and source.");
    }
    if (!args.source_file_ids.includes(input.source_file_id)) {
      throw new AssemblyError("invalid_input", "Extraction run source is outside the assembly source scope.");
    }
  }
  if (args.requested_kinds) {
    const requested = [...new Set(args.requested_kinds)];
    if (requested.some(kind => kind !== "need_extract" && kind !== "inventory_extract")) {
      throw new AssemblyError("invalid_input", "Assembly requested kinds are invalid.");
    }
    const actual = new Set(orderedRuns.map(row => row.call_kind));
    if (requested.length !== orderedRuns.length || requested.some(kind => !actual.has(kind))) {
      throw new AssemblyError("invalid_input", "Extraction runs do not match the requested assembly scope.");
    }
  }

  const [versions, events] = await Promise.all([
    runIds.length ? accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, args.workspace_id), inArray(t.accuracyItemVersions.run_id, runIds))) : [],
    runIds.length ? accuracyDb().select().from(t.accuracyAgentEvents)
      .where(and(eq(t.accuracyAgentEvents.workspace_id, args.workspace_id), inArray(t.accuracyAgentEvents.run_id, runIds))) : [],
  ]);

  const selections: AssemblySelection[] = [];
  for (const run of orderedRuns) {
    const { kind, items } = finalItems(run);
    items.forEach((item, item_index) => {
      const version = chooseVersion({ run, kind, item, item_index, versions, events });
      selections.push({
        item_version_id: version.id,
        reason: `Selected persisted judged ${kind} output from run ${run.id} item ${item_index} using ${originLabel(version)}.`,
      });
    });
  }

  const resolved = await resolveAssemblyItems(args.workspace_id, selections);
  const gaps = resolved.filter((item) => item.claim_type === "gap");
  const tactics = resolved.filter((item) => item.claim_type === "tactic");
  const coverage_run_ids: string[] = [];
  const mappings: AssemblyMapping[] = [];
  for (const gap of gaps) {
    for (const tactic of tactics) {
      const input = {
        workspace_id: args.workspace_id,
        generation_context: { evaluation_context },
        gap_id: gap.id,
        tactic_id: tactic.id,
        block_bundle_ids: evidenceBlockIds(gap, tactic),
        selected_versions: {
          gap_version_id: gap.id,
          tactic_version_id: tactic.id,
          gap_payload: gap.payload,
          tactic_payload: tactic.payload,
        },
      };
      const result = await runCoverageDecision({
        base_run_id: reservedCoverageRunId(args.generation_key, gap.id, tactic.id),
        input,
        actor: args.actor,
        org_id: args.org_id,
        workspace_id: args.workspace_id,
        evaluation_context,
      });
      coverage_run_ids.push(result.run_id);
      if (result.output.overall !== "not_relevant") {
        mappings.push({ gap_version_id: gap.id, tactic_version_id: tactic.id });
      }
    }
  }

  return createAssembly({
    workspace_id: args.workspace_id,
    actor: args.actor,
    source_file_ids: args.source_file_ids.length ? args.source_file_ids : sourceIdsFromRuns(orderedRuns),
    selections,
    mappings,
    coverage_run_ids,
    extraction_runs: extractionRunScope(orderedRuns),
    linking_complete: true,
    generation_key: args.generation_key,
  });
}
