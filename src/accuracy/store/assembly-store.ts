/** Immutable assembly persistence with workspace-scoped origin resolution. */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@/accuracy/kernel/contracts";
import {
  AssemblyError,
  assemblyFingerprint,
  checkAssembly,
  type Assembly,
  type AssemblyCoverage,
  type AssemblyExtractionRun,
  type AssemblyMapping,
  type AssemblySelection,
  type ResolvedAssemblyItem,
} from "@/accuracy/domain/assembly";
import type { AccuracyClaimType } from "./claim-store";
import { accuracyDb, ensureAccuracySchema, withAccuracyTransaction } from "./db";
import type { ParseBlock } from "./quote-validator";
import { newId, nowIso } from "@/modules/kernel/ids";
import * as t from "./schema";

type ClaimRow = typeof t.accuracyClaims.$inferSelect;
type ItemVersionRow = typeof t.accuracyItemVersions.$inferSelect;
type ModuleRunRow = typeof t.accuracyModuleRuns.$inferSelect;

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

function metadata(row: ClaimRow): Record<string, unknown> {
  return row.metadata as Record<string, unknown>;
}

function canonicalClaimId(claims: Map<string, ClaimRow>, id: string): string {
  const visited = new Set<string>();
  let current = id;
  while (true) {
    if (visited.has(current)) throw new AssemblyError("conflict", "Cyclic identity is stored.");
    visited.add(current);
    const row = claims.get(current);
    const next = row && typeof metadata(row).merged_into === "string" ? metadata(row).merged_into as string : null;
    if (!next) return current;
    current = next;
  }
}

function requireActor(actor: Actor) {
  if (!actor?.name?.trim() || !actor?.function?.trim()) {
    throw new AssemblyError("invalid_input", "A contributor identity is required.");
  }
}

function requireDistinctIds(ids: string[], label: string, allowEmpty = false) {
  if (!allowEmpty && ids.length === 0) throw new AssemblyError("invalid_input", `${label} must not be empty.`);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new AssemblyError("invalid_input", `${label} must contain distinct nonempty IDs.`);
  }
}

function requireReason(selection: AssemblySelection): string {
  const reason = selection.reason?.trim();
  if (!reason) throw new AssemblyError("invalid_input", "Selection reason must be nonempty.");
  return reason;
}

function outputItemAt(claim_type: AccuracyClaimType, output: unknown, item_index: number): Record<string, unknown> | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const rows = (output as Record<string, unknown>)[claim_type === "gap" ? "gaps" : "tactics"];
  if (!Array.isArray(rows)) return null;
  const row = rows[item_index];
  return row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : null;
}

function assertExtractionRun(row: ItemVersionRow, run: ModuleRunRow | undefined) {
  const expectedKind = row.claim_type === "gap" ? "need_extract" : row.claim_type === "tactic" ? "inventory_extract" : null;
  if (!run || run.workspace_id !== row.workspace_id || run.status !== "ok" || run.call_kind !== expectedKind) {
    throw new AssemblyError("invalid_input", "Selected item version is not bound to a successful extraction run.");
  }
  const input = run.input as Record<string, unknown>;
  if (input.workspace_id !== row.workspace_id || input.source_file_id !== row.source_file_id) {
    throw new AssemblyError("invalid_input", "Selected item version run input does not match its stored source.");
  }
}

function assertVersionOrigin(row: ItemVersionRow, run: ModuleRunRow, snapshot: typeof t.accuracyAgentEvents.$inferSelect | undefined) {
  if (row.snapshot_id) {
    if (!snapshot || snapshot.workspace_id !== row.workspace_id || snapshot.run_id !== row.run_id ||
      snapshot.event_type !== "snapshot" || snapshot.iteration !== row.iteration) {
      throw new AssemblyError("invalid_input", "Selected item version snapshot origin is invalid.");
    }
    const payload = snapshot.payload as Record<string, unknown>;
    const item = outputItemAt(row.claim_type as AccuracyClaimType, payload.output, row.item_index);
    if (!item || !sameJson(item, row.payload)) {
      throw new AssemblyError("invalid_input", "Selected item version payload does not match its snapshot origin.");
    }
    return;
  }
  if (row.iteration !== null) {
    throw new AssemblyError("invalid_input", "Final-output item origins must not record an iteration.");
  }
  const item = outputItemAt(row.claim_type as AccuracyClaimType, run.output, row.item_index);
  if (!item || !sameJson(item, row.payload)) {
    throw new AssemblyError("invalid_input", "Selected item version payload does not match its final output origin.");
  }
}

function coverageMode(row: ModuleRunRow): "llm" | "stub" {
  const input = row.input as Record<string, unknown>;
  if (input.mode === "stub") return "stub";
  const steps = Array.isArray(row.steps) ? row.steps : [];
  const modeStep = steps.find((step) => step && typeof step === "object"
    && (step as Record<string, unknown>).name === "coverage:mode") as Record<string, unknown> | undefined;
  return modeStep?.data === "stub" ? "stub" : "llm";
}

async function lockWorkspace(workspace_id: string) {
  await accuracyDb().execute(sql`select pg_advisory_xact_lock(hashtextextended(${`omission:${workspace_id}`}, 0))`);
}

async function requireSources(workspace_id: string, source_file_ids: string[]) {
  requireDistinctIds(source_file_ids, "Source files");
  const rows = await accuracyDb().select().from(t.accuracySourceFiles)
    .where(and(eq(t.accuracySourceFiles.workspace_id, workspace_id), inArray(t.accuracySourceFiles.id, source_file_ids)));
  if (rows.length !== source_file_ids.length) {
    throw new AssemblyError("not_found", "A source file is outside this workspace.");
  }
  return rows;
}

async function parseBlocks(workspace_id: string, source_file_ids: string[]) {
  if (source_file_ids.length === 0) return [];
  const rows = await accuracyDb().select().from(t.accuracyParseBlocks).where(and(
    eq(t.accuracyParseBlocks.workspace_id, workspace_id),
    inArray(t.accuracyParseBlocks.source_file_id, source_file_ids),
  ));
  return rows as ParseBlock[];
}

/** Resolve selected item versions, canonical identities, and immutable origins from the database. */
export async function resolveAssemblyItems(workspace_id: string, selections: AssemblySelection[]): Promise<ResolvedAssemblyItem[]> {
  await ensureAccuracySchema();
  if (!Array.isArray(selections)) throw new AssemblyError("invalid_input", "Selections must be an array.");
  const ids = selections.map((selection) => selection.item_version_id);
  requireDistinctIds(ids, "Selections", true);
  const reasons = new Map(selections.map((selection) => [selection.item_version_id, requireReason(selection)]));
  if (ids.length === 0) return [];

  const rows = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(and(eq(t.accuracyItemVersions.workspace_id, workspace_id), inArray(t.accuracyItemVersions.id, ids)));
  if (rows.length !== ids.length) throw new AssemblyError("not_found", "A selected item version is outside this workspace.");

  const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, workspace_id));
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const runIds = [...new Set(rows.flatMap((row) => row.run_id ? [row.run_id] : []))];
  const runs = runIds.length === 0 ? [] : await accuracyDb().select().from(t.accuracyModuleRuns)
    .where(and(eq(t.accuracyModuleRuns.workspace_id, workspace_id), inArray(t.accuracyModuleRuns.id, runIds)));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const sourceIds = [...new Set(rows.map((row) => row.source_file_id))];
  const sources = await accuracyDb().select().from(t.accuracySourceFiles)
    .where(and(eq(t.accuracySourceFiles.workspace_id, workspace_id), inArray(t.accuracySourceFiles.id, sourceIds)));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const snapshotIds = rows.flatMap((row) => row.snapshot_id ? [row.snapshot_id] : []);
  const snapshots = snapshotIds.length === 0 ? [] : await accuracyDb().select().from(t.accuracyAgentEvents)
    .where(and(eq(t.accuracyAgentEvents.workspace_id, workspace_id), inArray(t.accuracyAgentEvents.id, snapshotIds)));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = rowsById.get(id)!;
    const claim = claimsById.get(row.claim_id);
    if (!claim || claim.claim_type !== row.claim_type) {
      throw new AssemblyError("invalid_input", "Selected item version claim origin is invalid.");
    }
    const source = sourcesById.get(row.source_file_id);
    if (!source || claim.source_file_id !== row.source_file_id) {
      throw new AssemblyError("invalid_input", "Selected item version source origin is invalid.");
    }
    if (row.human_origin) {
      const origin = row.human_origin;
      if (row.run_id !== null || row.snapshot_id !== null || row.iteration !== null
        || origin.kind !== "human" || !origin.subject?.trim() || !origin.provider?.trim()
        || !origin.actor?.name?.trim() || !origin.actor?.function?.trim() || !origin.reason?.trim()
        || !origin.revision_id || !origin.parent_assembly_id || !["add", "edit"].includes(origin.action)
        || origin.source_file_id !== row.source_file_id || !sameJson(origin.provenance, row.payload.provenance)) {
        throw new AssemblyError("invalid_input", "Selected human item version origin is invalid.");
      }
    } else {
      const run = row.run_id ? runsById.get(row.run_id) : undefined;
      assertExtractionRun(row, run);
      if (run!.org_id !== source.org_id) {
        throw new AssemblyError("invalid_input", "Selected item version run and source organizations do not match.");
      }
      assertVersionOrigin(row, run!, row.snapshot_id ? snapshotsById.get(row.snapshot_id) : undefined);
    }
    return {
      id: row.id,
      claim_id: row.claim_id,
      run_id: row.run_id,
      ...(row.human_origin ? { human_origin: row.human_origin } : {}),
      snapshot_id: row.snapshot_id,
      iteration: row.iteration,
      item_index: row.item_index,
      payload: row.payload,
      source_file_id: row.source_file_id,
      created_at: row.created_at,
      claim_type: row.claim_type as "gap" | "tactic",
      canonical_claim_id: canonicalClaimId(claimsById, row.claim_id),
      reason: reasons.get(row.id)!,
    };
  });
}

async function resolveCoverage(workspace_id: string, run_ids: string[], items: ResolvedAssemblyItem[]): Promise<AssemblyCoverage[]> {
  requireDistinctIds(run_ids, "Coverage runs", true);
  if (run_ids.length === 0) return [];
  const rows = await accuracyDb().select().from(t.accuracyModuleRuns)
    .where(and(eq(t.accuracyModuleRuns.workspace_id, workspace_id), inArray(t.accuracyModuleRuns.id, run_ids)));
  if (rows.length !== run_ids.length) throw new AssemblyError("not_found", "A coverage run is outside this workspace.");
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return run_ids.map((id) => {
    const row = rowsById.get(id)!;
    if (row.status !== "ok" || row.call_kind !== "coverage_decide") {
      throw new AssemblyError("invalid_input", "Coverage run must be a successful coverage_decide call.");
    }
    if (!row.output) throw new AssemblyError("invalid_input", "Coverage run is missing persisted output.");
    const input = row.input as Record<string, unknown>;
    const gap_version_id = typeof input.gap_id === "string" ? input.gap_id : null;
    const tactic_version_id = typeof input.tactic_id === "string" ? input.tactic_id : null;
    if (!gap_version_id || !tactic_version_id || !itemsById.has(gap_version_id) || !itemsById.has(tactic_version_id)) {
      throw new AssemblyError("invalid_input", "Coverage run does not target selected item versions.");
    }
    return {
      run_id: row.id,
      gap_version_id,
      tactic_version_id,
      input,
      output: row.output,
      mode: coverageMode(row),
    };
  });
}

function assemblyFromRows(
  header: typeof t.accuracyAssemblies.$inferSelect,
  itemRows: Array<typeof t.accuracyAssemblyItems.$inferSelect>,
): Assembly {
  return {
    id: header.id,
    workspace_id: header.workspace_id,
    created_at: header.created_at,
    actor: { name: header.actor_name, function: header.actor_function as Actor["function"] },
    fingerprint: header.fingerprint,
    source_file_ids: header.source_file_ids,
    items: itemRows.map((row) => row.resolved_item as ResolvedAssemblyItem),
    mappings: header.mappings as AssemblyMapping[],
    coverage: header.coverage as AssemblyCoverage[],
    extraction_runs: (header.extraction_runs as AssemblyExtractionRun[] | null) ?? null,
    linking_complete: header.linking_complete,
    generation_key: header.generation_key,
    output: header.output as Assembly["output"],
    checks: header.checks as Assembly["checks"],
  };
}

async function loadAssembly(workspace_id: string, assembly_id: string): Promise<Assembly | null> {
  const [header] = await accuracyDb().select().from(t.accuracyAssemblies).where(and(
    eq(t.accuracyAssemblies.workspace_id, workspace_id),
    eq(t.accuracyAssemblies.id, assembly_id),
  )).limit(1);
  if (!header) return null;
  const items = await accuracyDb().select().from(t.accuracyAssemblyItems).where(and(
    eq(t.accuracyAssemblyItems.workspace_id, workspace_id),
    eq(t.accuracyAssemblyItems.assembly_id, assembly_id),
  )).orderBy(asc(t.accuracyAssemblyItems.position));
  return assemblyFromRows(header, items);
}

/** Read one immutable assembly by ID, scoped to a workspace. */
export async function readAssembly(workspace_id: string, assembly_id: string): Promise<Assembly | null> {
  await ensureAccuracySchema();
  return loadAssembly(workspace_id, assembly_id);
}

/** List immutable assemblies for a workspace, newest first. */
export async function listAssemblies(workspace_id: string): Promise<Assembly[]> {
  await ensureAccuracySchema();
  const headers = await accuracyDb().select().from(t.accuracyAssemblies)
    .where(eq(t.accuracyAssemblies.workspace_id, workspace_id))
    .orderBy(desc(t.accuracyAssemblies.created_at), desc(t.accuracyAssemblies.id));
  const assemblies: Assembly[] = [];
  for (const header of headers) {
    const itemRows = await accuracyDb().select().from(t.accuracyAssemblyItems).where(and(
      eq(t.accuracyAssemblyItems.workspace_id, workspace_id),
      eq(t.accuracyAssemblyItems.assembly_id, header.id),
    )).orderBy(asc(t.accuracyAssemblyItems.position));
    assemblies.push(assemblyFromRows(header, itemRows));
  }
  return assemblies;
}

/** Create an immutable assembly from server-resolved versions and coverage runs. */
export async function createAssembly(args: {
  workspace_id: string;
  actor: Actor;
  source_file_ids: string[];
  selections: AssemblySelection[];
  mappings: AssemblyMapping[];
  coverage_run_ids: string[];
  extraction_runs?: AssemblyExtractionRun[] | null;
  linking_complete: boolean;
  generation_key?: string;
}): Promise<Assembly> {
  requireActor(args.actor);
  return withAccuracyTransaction(async () => {
    await lockWorkspace(args.workspace_id);
    await requireSources(args.workspace_id, args.source_file_ids);
    const items = await resolveAssemblyItems(args.workspace_id, args.selections);
    const coverage = await resolveCoverage(args.workspace_id, args.coverage_run_ids, items);
    const output = {
      gaps: items.filter((item) => item.claim_type === "gap").map((item) => item.payload),
      tactics: items.filter((item) => item.claim_type === "tactic").map((item) => item.payload),
    };
    const blocks = await parseBlocks(args.workspace_id, args.source_file_ids);
    const checks = checkAssembly({
      items,
      source_file_ids: args.source_file_ids,
      blocks,
      mappings: args.mappings,
      coverage,
      linking_complete: args.linking_complete,
    });
    const fingerprint = assemblyFingerprint({
      source_file_ids: args.source_file_ids,
      items,
      mappings: args.mappings,
      coverage,
      extraction_runs: args.extraction_runs ?? null,
      linking_complete: args.linking_complete,
    });

    const generation_key = args.generation_key?.trim() || null;
    if (generation_key) {
      const [existing] = await accuracyDb().select().from(t.accuracyAssemblies).where(and(
        eq(t.accuracyAssemblies.workspace_id, args.workspace_id),
        eq(t.accuracyAssemblies.generation_key, generation_key),
      )).limit(1);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new AssemblyError("conflict", "Generation key already identifies different assembly content.");
        }
        const retained = await loadAssembly(args.workspace_id, existing.id);
        if (!retained) throw new AssemblyError("conflict", "Generation key references an unreadable assembly.");
        return retained;
      }
    }

    const id = newId("asm");
    const created_at = nowIso();
    await accuracyDb().insert(t.accuracyAssemblies).values({
      id,
      workspace_id: args.workspace_id,
      created_at,
      actor_name: args.actor.name.trim(),
      actor_function: args.actor.function,
      fingerprint,
      source_file_ids: args.source_file_ids,
      mappings: args.mappings,
      coverage,
      extraction_runs: args.extraction_runs ?? null,
      linking_complete: args.linking_complete,
      output,
      checks,
      generation_key,
    });
    if (items.length > 0) {
      await accuracyDb().insert(t.accuracyAssemblyItems).values(items.map((item, position) => ({
        id: newId("asmi"),
        workspace_id: args.workspace_id,
        assembly_id: id,
        item_version_id: item.id,
        position,
        reason: item.reason,
        resolved_item: item,
      })));
    }
    const saved = await loadAssembly(args.workspace_id, id);
    if (!saved) throw new AssemblyError("conflict", "Assembly write did not produce a readable record.");
    return saved;
  });
}
