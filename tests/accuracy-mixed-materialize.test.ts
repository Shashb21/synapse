import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { insertClaim } from "@/accuracy/store/claim-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { assemblyFingerprint } from "@/accuracy/domain/assembly";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { copyExperimentWorkspace } from "@/accuracy/experiments/copy-workspace";
import { materializeMixedCandidate, resolveMixedCandidates } from "@/accuracy/experiments/mixed-materialize";
import { mixedCandidateEvidenceSchema } from "@/accuracy/experiments/mixed-types";
import { newId, nowIso } from "@/modules/kernel/ids";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
vi.mock("@/lib/iegp/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iegp/db")>();
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL!, { max: 4 });
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { ...actual, sharedDb: () => drizzle(client) };
});
const workspaces: string[] = [];
const actor = { name: "Materialize fixture", function: "medical_affairs" as const };
async function fixture() {
  const org_id = await createOrganization("KAN-40 materialize");
  const workspace_id = await createWorkspace({ org_id, name: "source", slug: newId("slug") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: "fixture-checksum" });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "prose", heading: null, text: "Original evidence supports the selected need.", parser: "fixture", created_at: nowIso() });
  const payload = { id: newId("gap"), statement: "Exact snapshot need", external_id: "G-1",
    provenance: [{ source_file_id: source.id, block_id, quote: "supports the selected need" }] };
  const final = { ...payload, statement: "Different final need" };
  const run_id = newId("run"), snapshot_id = newId("event"), now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id, workspace_id, call_kind: "need_extract", agent_role: "judge",
    module_id: "fixture", module_version: "1", status: "ok", started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id, source_file_id: source.id }, output: { workspace_id, source_file_id: source.id, gaps: [final] }, steps: [] });
  await accuracyDb().insert(t.accuracyAgentEvents).values({ id: snapshot_id, run_id, workspace_id, event_type: "snapshot", iteration: 0,
    payload: { output: { gaps: [payload] } }, recorded_at: now });
  await publishGeneratedItemHistory({ workspace_id, source_file_id: source.id, run_id, claim_type: "gap",
    final_claims: [{ id: payload.id, workspace_id, source_file_id: source.id, claim_type: "gap", statement: final.statement }] });
  const versions = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.run_id, run_id));
  const version = versions.find(row => row.snapshot_id === snapshot_id)!;
  const assembly = await createAssembly({ workspace_id, actor, source_file_ids: [source.id], selections: [{ item_version_id: version.id, reason: "Best snapshot" }],
    mappings: [], coverage_run_ids: [], linking_complete: true });
  const unrelated = await insertClaim({ workspace_id, source_file_id: source.id, claim_type: "tactic", statement: "Unselected tactic" });
  await accuracyDb().insert(t.accuracyCoverageJoins).values({ id: newId("cov"), workspace_id, gap_id: version.claim_id, tactic_id: unrelated.id,
    overall: "partial", dimensions: {}, confidence: "0.5", validated: false, rationale: "stale copied join" });
  const request = { source_workspace_id: workspace_id, source_file_ids: [source.id], pack_id: "beone-bgb-58067-prmt5i", actor,
    mixed: { assembly_id: assembly.id, fingerprint: assembly.fingerprint }, baseline: { assembly_id: assembly.id, fingerprint: assembly.fingerprint } };
  return { workspace_id, org_id, source, block_id, payload, run_id, snapshot_id, version, assembly, request };
}
async function copyOf(f: Awaited<ReturnType<typeof fixture>>) {
  const copy = await copyExperimentWorkspace({ source_workspace_id: f.workspace_id, source_file_ids: [f.source.id] });
  workspaces.push(copy.workspace_id);
  return copy;
}
afterEach(async () => { for (const id of workspaces.splice(0).reverse()) await deleteWorkspace(id); });
afterAll(async () => { await closePool(); });

describe("exact mixed candidate materialization", () => {
  it("selected_versions_are_the_only_materialized_inventory", async () => {
    const f = await fixture();
    const before = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, f.workspace_id));
    const copy = await copyOf(f);
    const resolved = await resolveMixedCandidates(f.request);
    const evidence = await materializeMixedCandidate({ label: "mixed", assembly: resolved.mixed, copy });
    expect(mixedCandidateEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(evidence).toMatchObject({ label: "mixed", status: "pending", attempt_id: null, setup: null, original_assembly: f.assembly });
    expect(evidence.lineage).toHaveLength(1);
    expect(evidence.lineage[0]).toMatchObject({ kind: "selected", original_item_version_id: f.version.id, original_run_id: f.run_id,
      original_snapshot_id: f.snapshot_id, original_iteration: 0, selection_reason: "Best snapshot", original_payload: f.payload });
    const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ statement: "Exact snapshot need", validated: false });
    expect(evidence.entry_source_inventory[0].original_provenance).toEqual(f.payload.provenance);
    expect(await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, copy.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, f.workspace_id))).toEqual(before);
    expect(evidence.stages.every(stage => stage.status === "pending")).toBe(true);
    expect(evidence.copy?.original_content_fingerprint).toBe(f.assembly.fingerprint);
    expect(evidence.copy?.remapped_content_fingerprint).not.toBe(f.assembly.fingerprint);
  });
});

describe("candidate isolation and rejection", () => {
  it("snapshot_gap_and_final_tactic_keep_their_exact_distinct_origins", async () => {
    const f = await fixture();
    const payload = { id: newId("tac"), name: "Exact final tactic", type: "publication", status: "planned", origin: "inventory",
      evidence_question: "Does this meet the selected need?", provenance: f.payload.provenance };
    const run_id = newId("run"), now = nowIso();
    await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id: f.org_id, workspace_id: f.workspace_id,
      call_kind: "inventory_extract", agent_role: "judge", module_id: "fixture", module_version: "1", status: "ok",
      started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
      input: { workspace_id: f.workspace_id, source_file_id: f.source.id },
      output: { workspace_id: f.workspace_id, source_file_id: f.source.id, tactics: [payload] }, steps: [] });
    await publishGeneratedItemHistory({ workspace_id: f.workspace_id, source_file_id: f.source.id, run_id, claim_type: "tactic",
      final_claims: [{ id: payload.id, workspace_id: f.workspace_id, source_file_id: f.source.id, claim_type: "tactic", statement: payload.name }] });
    const [version] = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.run_id, run_id));
    const assembly = await createAssembly({ workspace_id: f.workspace_id, actor, source_file_ids: [f.source.id], selections: [
      { item_version_id: f.version.id, reason: "Best snapshot" }, { item_version_id: version.id, reason: "Final tactic" }],
      mappings: [], coverage_run_ids: [], linking_complete: false });
    const copy = await copyOf(f);
    const evidence = await materializeMixedCandidate({ label: "mixed", assembly, copy });
    expect(evidence.lineage).toHaveLength(2);
    expect(evidence.lineage[1]).toMatchObject({ kind: "selected", original_run_id: run_id, original_snapshot_id: null,
      original_iteration: null, selection_reason: "Final tactic", original_payload: payload });
    const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id));
    expect(claims.map(row => row.statement).sort()).toEqual(["Exact final tactic", "Exact snapshot need"]);
    expect(claims.find(row => row.claim_type === "tactic")?.metadata).toMatchObject({ tactic_type: "publication", tactic_status: "planned", origin: "inventory" });
  });

  it("failed_insertion_rolls_back_copy_pruning_atomically", async () => {
    const f = await fixture(), copy = await copyOf(f);
    const before = {
      claims: await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id)),
      provenance: await accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, copy.workspace_id)),
      coverage: await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, copy.workspace_id)),
    };
    // Test-only constraint affects this generated workspace alone and forces a real
    // Postgres insert failure after pruning. Existing copied rows stay permitted.
    const constraint = newId("kan40_insert_failure").replace(/[^a-zA-Z0-9_]/g, "_");
    const copiedWorkspaceLiteral = copy.workspace_id.replace(/'/g, "''");
    await accuracyDb().execute(sql.raw(`ALTER TABLE accuracy_claims ADD CONSTRAINT "${constraint}" CHECK (workspace_id <> '${copiedWorkspaceLiteral}' OR statement <> 'Exact snapshot need') NOT VALID`));
    try {
      await expect(materializeMixedCandidate({ label: "mixed", assembly: f.assembly, copy })).rejects.toThrow();
      expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id))).toEqual(before.claims);
      expect(await accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, copy.workspace_id))).toEqual(before.provenance);
      expect(await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, copy.workspace_id))).toEqual(before.coverage);
    } finally {
      await accuracyDb().execute(sql.raw(`ALTER TABLE accuracy_claims DROP CONSTRAINT "${constraint}"`));
    }
  });
  it("remapped_quotes_match_original_blocks", async () => {
    const f = await fixture(), copy = await copyOf(f);
    const evidence = await materializeMixedCandidate({ label: "baseline", assembly: f.assembly, copy });
    const spans = await accuracyDb().select().from(t.accuracyProvenance).where(eq(t.accuracyProvenance.workspace_id, copy.workspace_id));
    const blocks = await accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, copy.workspace_id));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ source_file_id: copy.source_id_map[f.source.id], block_id: copy.block_id_map[f.block_id], quote: "supports the selected need" });
    expect(blocks[0].text).toContain(spans[0].quote);
    expect(evidence.entry_source_inventory[0].payload.provenance).toEqual([{ source_file_id: copy.source_id_map[f.source.id], block_id: copy.block_id_map[f.block_id], quote: "supports the selected need" }]);
    expect(evidence.lineage[0]).toMatchObject({ original_payload: f.payload, copied_evidence_ids: [spans[0].id] });
    expect(Object.values(evidence.copy!.provenance_id_map)).toEqual([spans[0].id]);
    expect((await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, copy.workspace_id)))[0].reference_pack_id).toBeNull();
    expect(evidence.original_assembly).toEqual(f.assembly);
  });

  it("stale_or_cross_workspace_candidates_fail_before_writes", async () => {
    const f = await fixture(), other = await fixture();
    const before = await accuracyDb().select().from(t.accuracyWorkspaces);
    for (const request of [
      { ...f.request, mixed: { ...f.request.mixed, fingerprint: "stale" } },
      { ...f.request, mixed: other.request.mixed },
      { ...f.request, source_file_ids: [other.source.id] },
    ]) await expect(resolveMixedCandidates(request)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyWorkspaces)).toEqual(before);
    await accuracyDb().update(t.accuracyModuleRuns).set({ org_id: other.org_id }).where(eq(t.accuracyModuleRuns.id, f.run_id));
    await expect(resolveMixedCandidates(f.request)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyWorkspaces)).toEqual(before);
  });

  it("human_revision_origin_is_rejected", async () => {
    const f = await fixture();
    const claim = await insertClaim({ workspace_id: f.workspace_id, source_file_id: f.source.id, claim_type: "gap", statement: "Human correction" });
    const version_id = newId("version"), now = nowIso();
    const payload = { ...f.payload, id: claim.id, statement: "Human correction" };
    await accuracyDb().insert(t.accuracyItemVersions).values({ id: version_id, workspace_id: f.workspace_id, claim_id: claim.id, run_id: null,
      snapshot_id: null, iteration: null, item_index: 0, claim_type: "gap", fingerprint: "human-history", payload, source_file_id: f.source.id,
      created_at: now, origin_key: `human:${version_id}`, human_origin: { kind: "human", revision_id: newId("revision"), subject: "fixture-subject",
        provider: "fixture-provider", actor, action: "edit", reason: "Reviewed correction", parent_assembly_id: f.assembly.id,
        predecessor_version_id: f.version.id, source_file_id: f.source.id, provenance: payload.provenance, created_at: now } });
    const human = await createAssembly({ workspace_id: f.workspace_id, actor, source_file_ids: [f.source.id], selections: [{ item_version_id: version_id, reason: "Human correction" }],
      mappings: [], coverage_run_ids: [], linking_complete: true });
    await expect(resolveMixedCandidates({ ...f.request, mixed: { assembly_id: human.id, fingerprint: human.fingerprint } })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("empty_assemblies_and_missing_lineage_are_rejected", async () => {
    const f = await fixture();
    const empty = await createAssembly({ workspace_id: f.workspace_id, actor, source_file_ids: [f.source.id], selections: [], mappings: [], coverage_run_ids: [], linking_complete: true });
    await expect(resolveMixedCandidates({ ...f.request, mixed: { assembly_id: empty.id, fingerprint: empty.fingerprint } })).rejects.toMatchObject({ code: "invalid_input" });
    await accuracyDb().update(t.accuracyModuleRuns).set({ output: { gaps: [] } }).where(eq(t.accuracyModuleRuns.id, f.run_id));
    // The selected snapshot remains valid; corrupt that exact origin, not final text.
    await accuracyDb().update(t.accuracyAgentEvents).set({ payload: { output: { gaps: [] } } }).where(eq(t.accuracyAgentEvents.id, f.snapshot_id));
    await expect(resolveMixedCandidates(f.request)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("unresolved_copy_maps_and_live_targets_do_not_prune_rows", async () => {
    const f = await fixture(), copy = await copyOf(f);
    const before = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id));
    for (const invalidCopy of [
      { ...copy, block_id_map: {} },
      { ...copy, workspace_id: f.workspace_id, org_id: f.org_id },
      { ...copy, source_id_map: { [f.source.id]: f.source.id } },
    ]) await expect(materializeMixedCandidate({ label: "mixed", assembly: f.assembly, copy: invalidCopy })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id))).toEqual(before);
    await accuracyDb().update(t.accuracyParseBlocks).set({ text: "Changed copied quote" }).where(eq(t.accuracyParseBlocks.id, copy.block_id_map[f.block_id]));
    await expect(materializeMixedCandidate({ label: "mixed", assembly: f.assembly, copy })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id))).toEqual(before);
  });

  it("gold_seeded_sources_are_rejected_before_copy_writes", async () => {
    const f = await fixture();
    const before = await accuracyDb().select().from(t.accuracyWorkspaces);
    await accuracyDb().update(t.accuracySourceFiles).set({ reference_pack_id: f.request.pack_id }).where(eq(t.accuracySourceFiles.id, f.source.id));
    await expect(resolveMixedCandidates(f.request)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyWorkspaces)).toEqual(before);
  });

  it("stale_version_fingerprint_is_rejected", async () => {
    const f = await fixture();
    await accuracyDb().update(t.accuracyItemVersions).set({ fingerprint: "stale" }).where(eq(t.accuracyItemVersions.id, f.version.id));
    await expect(resolveMixedCandidates(f.request)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("missing_or_crossed_original_provenance_is_rejected", async () => {
    const f = await fixture(), other = await fixture();
    await accuracyDb().update(t.accuracyParseBlocks).set({ source_file_id: other.source.id }).where(eq(t.accuracyParseBlocks.id, f.block_id));
    await expect(resolveMixedCandidates(f.request)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("forged_assembly_output_is_rejected_without_pruning", async () => {
    const f = await fixture(), copy = await copyOf(f);
    const before = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id));
    const forged = { ...f.assembly, output: { gaps: [{ ...f.payload, statement: "Mutable substitute" }], tactics: [] } };
    // Output is not part of the assembly fingerprint; exact output validation is required.
    expect(assemblyFingerprint(forged)).toBe(f.assembly.fingerprint);
    await expect(materializeMixedCandidate({ label: "mixed", assembly: forged, copy })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, copy.workspace_id))).toEqual(before);
  });
});

describe("input_rejection", () => {
  it.each([{}, { source_workspace_id: "workspace", source_file_ids: [] }, { actor: { name: "", function: "medical_affairs" } }])("rejects malformed nominations before database access: %j", async request => {
    await expect(resolveMixedCandidates(request as unknown as Parameters<typeof resolveMixedCandidates>[0])).rejects.toMatchObject({ code: "invalid_input" });
  });
});
