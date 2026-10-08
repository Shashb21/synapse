import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { accuracyDb, withAccuracyTransaction } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { applyClaimValidation, listClaims, listDownstreamClaims } from "@/accuracy/store/claim-store";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { decideItemRelationship, publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { createAssembly, listAssemblies, readAssembly, resolveAssemblyItems } from "@/accuracy/store/assembly-store";
import { newId, nowIso } from "@/modules/kernel/ids";

const { closePool } = vi.hoisted(() => ({ closePool: vi.fn() }));
// Keep production store transaction code, but give its underlying pool enough
// connections to exercise independent transactions inside this file.
vi.mock("@/lib/iegp/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iegp/db")>();
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse", {
    max: 4,
    connection: { application_name: "kan37-assembly-store-test" },
  });
  const database = drizzle(client);
  closePool.mockImplementation(() => client.end({ timeout: 5 }));
  return { ...actual, sharedDb: () => database };
});

const workspaces: string[] = [];
const actor = { name: "Assembly Agent", function: "medical_affairs" as const };

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const org_id = await createOrganization("assembly test");
  const workspace_id = await createWorkspace({ org_id, name: "assembly", slug: newId("slug") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, filename: "input.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "Shared source text supports the selected item.", parser: "test", created_at: nowIso() });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

function gap(scope: Fixture, statement: string, id = newId("gap")) {
  return { id, statement, external_id: id, provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "supports the selected item" }] };
}

function tactic(scope: Fixture, name: string, id = newId("tac")) {
  return { id, name, type: "publication", status: "planned", evidence_question: "Will this address the gap?",
    origin: "inventory", provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "supports the selected item" }] };
}

async function extractionRun(scope: Fixture, claim_type: "gap" | "tactic", snapshots: unknown[], final: unknown) {
  const id = newId("run");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: claim_type === "gap" ? "need_extract" : "inventory_extract", agent_role: "judge",
    module_id: "test", module_version: "1", status: "ok", started_at: now, finished_at: now,
    actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id }, output: final, steps: [] });
  for (const [iteration, output] of snapshots.entries()) {
    await accuracyDb().insert(t.accuracyAgentEvents).values({ id: newId("event"), run_id: id, workspace_id: scope.workspace_id,
      event_type: "snapshot", iteration, payload: { event_type: "snapshot", iteration, output }, recorded_at: now });
  }
  return id;
}

async function seedMixed(scope?: Fixture) {
  scope ??= await fixture();
  const rawGap = gap(scope, "Earlier source-backed gap");
  const finalGap = gap(scope, "Final source-backed gap");
  const finalTactic = tactic(scope, "Publish field guide");
  const gapFinal = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [finalGap] };
  const gapRun = await extractionRun(scope, "gap", [{ ...gapFinal, gaps: [rawGap] }], gapFinal);
  await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap", final_claims: [{
    id: finalGap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: finalGap.statement,
  }] });
  const tacticFinal = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [finalTactic] };
  const tacticRun = await extractionRun(scope, "tactic", [], tacticFinal);
  await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic", final_claims: [{
    id: finalTactic.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: finalTactic.name,
  }] });
  const versions = await accuracyDb().select().from(t.accuracyItemVersions)
    .where(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id));
  const gapVersion = versions.find((row) => row.claim_type === "gap" && row.snapshot_id);
  const tacticVersion = versions.find((row) => row.claim_type === "tactic");
  if (!gapVersion || !tacticVersion) throw new Error("fixture failed to publish versions");
  return { scope, rawGap, finalGap, finalTactic, gapRun, tacticRun, gapVersion, tacticVersion };
}

async function coverageRun(scope: Fixture, gap_version_id: string, tactic_version_id: string, gap_payload: Record<string, unknown>, tactic_payload: Record<string, unknown>) {
  const id = newId("run");
  const now = nowIso();
  const input = { workspace_id: scope.workspace_id, gap_id: gap_version_id, tactic_id: tactic_version_id,
    block_bundle_ids: [scope.block_id],
    selected_versions: { gap_version_id, tactic_version_id, gap_payload, tactic_payload } };
  const output = { gap_id: gap_version_id, tactic_id: tactic_version_id, overall: "partial" as const,
    quote_block_ids: [scope.block_id], confidence: 0.75, rationale: "Partial support." };
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: "coverage_decide", agent_role: "judge", module_id: "coverage", module_version: "1",
    status: "ok", started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input, output, steps: [] });
  return id;
}

afterEach(async () => {
  for (const id of workspaces.splice(0)) await deleteWorkspace(id);
});

afterAll(() => closePool());

describe("assembly store", () => {
  it("creates, reads, and retries an immutable mixed-origin assembly with server-resolved coverage", async () => {
    const { scope, rawGap, finalTactic, gapVersion, tacticVersion } = await seedMixed();
    const coverage_run_id = await coverageRun(scope, gapVersion.id, tacticVersion.id, gapVersion.payload, tacticVersion.payload);

    const assembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [{ item_version_id: gapVersion.id, reason: "  best raw gap  " }, { item_version_id: tacticVersion.id, reason: "selected final tactic" }],
      mappings: [{ gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id }],
      coverage_run_ids: [coverage_run_id], linking_complete: true, generation_key: "publication:1" });

    expect(assembly.items.map((row) => [row.id, row.reason, row.snapshot_id, row.iteration])).toEqual([
      [gapVersion.id, "best raw gap", gapVersion.snapshot_id, 0],
      [tacticVersion.id, "selected final tactic", tacticVersion.snapshot_id, null],
    ]);
    expect(assembly.output).toEqual({ gaps: [rawGap], tactics: [finalTactic] });
    expect(assembly.coverage).toHaveLength(1);
    expect(assembly.checks.status).toBe("passed");
    const retry = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [{ item_version_id: gapVersion.id, reason: "best raw gap" }, { item_version_id: tacticVersion.id, reason: "selected final tactic" }],
      mappings: [{ gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id }],
      coverage_run_ids: [coverage_run_id], linking_complete: true, generation_key: "publication:1" });
    expect(retry.id).toBe(assembly.id);
    await expect(createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [{ item_version_id: gapVersion.id, reason: "changed reason" }, { item_version_id: tacticVersion.id, reason: "selected final tactic" }],
      mappings: [{ gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id }],
      coverage_run_ids: [coverage_run_id], linking_complete: true, generation_key: "publication:1" }))
      .rejects.toMatchObject({ code: "conflict" });
    await accuracyDb().update(t.accuracyModuleRuns).set({ output: { changed: true } }).where(eq(t.accuracyModuleRuns.id, coverage_run_id));
    await accuracyDb().update(t.accuracyClaims).set({ statement: "mutable claim edit" }).where(eq(t.accuracyClaims.id, gapVersion.claim_id));

    const read = await readAssembly(scope.workspace_id, assembly.id);
    expect(read).toEqual(assembly);
    expect(await listAssemblies(scope.workspace_id)).toEqual([assembly]);
    const changed = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [{ item_version_id: gapVersion.id, reason: "changed reason" }, { item_version_id: tacticVersion.id, reason: "selected final tactic" }],
      mappings: [{ gap_version_id: gapVersion.id, tactic_version_id: tacticVersion.id }],
      coverage_run_ids: [], linking_complete: false });
    expect(changed.id).not.toBe(assembly.id);
  });

  it("scopes reads, selections, sources, and coverage runs to the workspace", async () => {
    const own = await seedMixed();
    const foreign = await seedMixed();
    const ownCoverage = await coverageRun(own.scope, own.gapVersion.id, own.tacticVersion.id, own.gapVersion.payload, own.tacticVersion.payload);
    const assembly = await createAssembly({ workspace_id: own.scope.workspace_id, actor, source_file_ids: [own.scope.source_file_id],
      selections: [{ item_version_id: own.gapVersion.id, reason: "gap" }, { item_version_id: own.tacticVersion.id, reason: "tactic" }],
      mappings: [], coverage_run_ids: [], linking_complete: false });

    expect(await readAssembly(foreign.scope.workspace_id, assembly.id)).toBeNull();
    await expect(resolveAssemblyItems(own.scope.workspace_id, [{ item_version_id: foreign.gapVersion.id, reason: "foreign" }]))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(createAssembly({ workspace_id: own.scope.workspace_id, actor, source_file_ids: [foreign.scope.source_file_id],
      selections: [{ item_version_id: own.gapVersion.id, reason: "gap" }], mappings: [], coverage_run_ids: [], linking_complete: false }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(createAssembly({ workspace_id: own.scope.workspace_id, actor, source_file_ids: [own.scope.source_file_id],
      selections: [{ item_version_id: own.gapVersion.id, reason: "gap" }, { item_version_id: own.tacticVersion.id, reason: "tactic" }],
      mappings: [], coverage_run_ids: [foreign.gapRun], linking_complete: false }))
      .rejects.toMatchObject({ code: "not_found" });
    await accuracyDb().update(t.accuracyModuleRuns).set({ status: "error" }).where(eq(t.accuracyModuleRuns.id, ownCoverage));
    await expect(createAssembly({ workspace_id: own.scope.workspace_id, actor, source_file_ids: [own.scope.source_file_id],
      selections: [{ item_version_id: own.gapVersion.id, reason: "gap" }, { item_version_id: own.tacticVersion.id, reason: "tactic" }],
      mappings: [], coverage_run_ids: [ownCoverage], linking_complete: false }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects tampered item origins but allows final-only origins", async () => {
    const good = await seedMixed();
    const otherSource = await insertSourceFile({ workspace_id: good.scope.workspace_id, filename: "other.txt", mime: "text/plain", checksum: newId("sum") });
    const makeVersion = async (patch: Partial<typeof t.accuracyItemVersions.$inferSelect>) => {
      const id = newId("iver");
      await accuracyDb().insert(t.accuracyItemVersions).values({ ...good.gapVersion, id, origin_key: newId("origin"), ...patch });
      return id;
    };
    for (const patch of [
      { source_file_id: otherSource.id },
      { run_id: good.tacticRun },
      { snapshot_id: good.tacticVersion.snapshot_id },
      { item_index: 99 },
      { payload: { ...good.rawGap, statement: "tampered" } },
    ]) {
      const id = await makeVersion(patch);
      await expect(resolveAssemblyItems(good.scope.workspace_id, [{ item_version_id: id, reason: "tampered" }]))
        .rejects.toMatchObject({ code: "invalid_input" });
    }

    const finalOnly = await resolveAssemblyItems(good.scope.workspace_id, [{ item_version_id: good.tacticVersion.id, reason: "final only" }]);
    expect(finalOnly[0]).toMatchObject({ snapshot_id: null, iteration: null, item_index: 0, reason: "final only" });
  });

  it("preserves exact original array positions when resolving snapshot origins", async () => {
    const scope = await fixture();
    const rawGap = gap(scope, "Second positioned raw gap");
    const finalGap = gap(scope, "Final source-backed gap");
    const final = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [finalGap] };
    const run_id = await extractionRun(scope, "gap", [{ ...final, gaps: [null, rawGap] }], final);
    await publishGeneratedItemHistory({ ...scope, run_id, claim_type: "gap", final_claims: [{
      id: finalGap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: finalGap.statement,
    }] });
    const [legitimate] = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.item_index, 1)));
    expect(legitimate?.payload).toEqual(rawGap);

    await expect(resolveAssemblyItems(scope.workspace_id, [{ item_version_id: legitimate.id, reason: "keeps index 1" }]))
      .resolves.toMatchObject([{ id: legitimate.id, item_index: 1, payload: rawGap }]);

    const forgedId = newId("iver");
    await accuracyDb().insert(t.accuracyItemVersions).values({ ...legitimate, id: forgedId, origin_key: newId("origin"), item_index: 0 });
    await expect(resolveAssemblyItems(scope.workspace_id, [{ item_version_id: forgedId, reason: "forged index" }]))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects coordinated source tampering across version and run input", async () => {
    const seeded = await seedMixed();
    const otherSource = await insertSourceFile({ workspace_id: seeded.scope.workspace_id, filename: "coordinated.txt", mime: "text/plain", checksum: newId("sum") });
    const forgedId = newId("iver");
    const forgedRun = newId("run");
    const forgedSnapshot = newId("event");
    const [run] = await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.id, seeded.gapRun));
    const [snapshot] = await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.id, seeded.gapVersion.snapshot_id!));
    await accuracyDb().insert(t.accuracyModuleRuns).values({
      ...run,
      id: forgedRun,
      input: { ...(run.input as Record<string, unknown>), source_file_id: otherSource.id },
    });
    await accuracyDb().insert(t.accuracyAgentEvents).values({
      ...snapshot,
      id: forgedSnapshot,
      run_id: forgedRun,
    });
    await accuracyDb().insert(t.accuracyItemVersions).values({
      ...seeded.gapVersion,
      id: forgedId,
      origin_key: newId("origin"),
      run_id: forgedRun,
      snapshot_id: forgedSnapshot,
      source_file_id: otherSource.id,
    });

    await expect(resolveAssemblyItems(seeded.scope.workspace_id, [{ item_version_id: forgedId, reason: "coordinated tamper" }]))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rolls back a successful nested assembly write when the outer transaction fails", async () => {
    const seeded = await seedMixed();
    let assemblyId = "";
    await expect(withAccuracyTransaction(async () => {
      const assembly = await createAssembly({ workspace_id: seeded.scope.workspace_id, actor, source_file_ids: [seeded.scope.source_file_id],
        selections: [{ item_version_id: seeded.gapVersion.id, reason: "written then rolled back" }],
        mappings: [], coverage_run_ids: [], linking_complete: false });
      assemblyId = assembly.id;
      throw new Error("force rollback after assembly write");
    })).rejects.toThrow("force rollback");

    expect(assemblyId).toMatch(/^asm_/);
    expect(await readAssembly(seeded.scope.workspace_id, assemblyId)).toBeNull();
    expect(await accuracyDb().select().from(t.accuracyAssemblyItems).where(eq(t.accuracyAssemblyItems.assembly_id, assemblyId))).toEqual([]);
  });

  it("serializes independent assembly creation and identity decision transactions under the workspace lock", async () => {
    const seeded = await seedMixed();
    const [proposal] = await accuracyDb().select().from(t.accuracyItemRelationshipProposals)
      .where(eq(t.accuracyItemRelationshipProposals.workspace_id, seeded.scope.workspace_id));
    const directUrl = process.env.DATABASE_URL ?? "postgres://synapse:synapse@127.0.0.1:5432/synapse";
    const blocker = postgres(directUrl, { max: 1, connection: { application_name: "kan37-assembly-lock-blocker" } });
    const monitor = postgres(directUrl, { max: 1, connection: { application_name: "kan37-assembly-lock-monitor" } });
    let releaseLock: () => void = () => undefined;
    let announceLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { announceLock = resolve; });
    const holdLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blockerTransaction = blocker.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`omission:${seeded.scope.workspace_id}`}, 0))`;
      announceLock();
      await holdLock;
    });
    let assemblyPromise: ReturnType<typeof createAssembly> | undefined;
    let decisionPromise: ReturnType<typeof decideItemRelationship> | undefined;

    try {
      await lockAcquired;
      assemblyPromise = createAssembly({ workspace_id: seeded.scope.workspace_id, actor, source_file_ids: [seeded.scope.source_file_id],
        selections: [{ item_version_id: seeded.gapVersion.id, reason: "queued before decision" }],
        mappings: [], coverage_run_ids: [], linking_complete: false });
      await vi.waitFor(async () => {
        await monitor`select pg_stat_clear_snapshot()`;
        const waiters = await monitor<{ pid: number; wait_event: string | null }[]>`
          select pid, wait_event from pg_stat_activity
          where application_name = 'kan37-assembly-store-test'
            and wait_event_type = 'Lock'`;
        expect(waiters.some((row) => row.wait_event === "advisory")).toBe(true);
      }, { timeout: 2_000, interval: 10 });

      decisionPromise = decideItemRelationship({ workspace_id: seeded.scope.workspace_id, proposal_id: proposal.id,
        action: "confirm", rationale: "Concurrent same item", actor });
      await vi.waitFor(async () => {
        await monitor`select pg_stat_clear_snapshot()`;
        const waiters = await monitor<{ pid: number; wait_event: string | null }[]>`
          select pid, wait_event from pg_stat_activity
          where application_name = 'kan37-assembly-store-test'
            and wait_event_type = 'Lock'`;
        expect(waiters.filter((row) => row.wait_event === "advisory")).toHaveLength(2);
        expect(new Set(waiters.map((row) => row.pid)).size).toBe(2);
      }, { timeout: 2_000, interval: 10 });

      expect(await accuracyDb().select().from(t.accuracyAssemblies).where(eq(t.accuracyAssemblies.workspace_id, seeded.scope.workspace_id))).toEqual([]);
      expect(await accuracyDb().select().from(t.accuracyItemRelationshipDecisions).where(eq(t.accuracyItemRelationshipDecisions.proposal_id, proposal.id))).toEqual([]);
      releaseLock();
      await blockerTransaction;

      const [assembly] = await Promise.all([assemblyPromise, decisionPromise.then(() => undefined)]);
      const current = await resolveAssemblyItems(seeded.scope.workspace_id, [{ item_version_id: seeded.gapVersion.id, reason: "after decision" }]);
      const saved = await readAssembly(seeded.scope.workspace_id, assembly.id);
      expect(saved?.items[0]?.canonical_claim_id).toBe(seeded.gapVersion.claim_id);
      expect(current[0]?.canonical_claim_id).toBe(seeded.finalGap.id);
    } finally {
      releaseLock();
      await blockerTransaction.catch(() => undefined);
      await Promise.allSettled([assemblyPromise, decisionPromise].filter((promise): promise is NonNullable<typeof promise> => Boolean(promise)));
      await blocker.end({ timeout: 5 });
      await monitor.end({ timeout: 5 });
    }
  });

  it("cleans up tenant assembly rows and leaves current claim readers unchanged", async () => {
    const seeded = await seedMixed();
    await expect(createAssembly({ workspace_id: seeded.scope.workspace_id, actor, source_file_ids: [seeded.scope.source_file_id],
      selections: [{ item_version_id: seeded.gapVersion.id, reason: "" }], mappings: [], coverage_run_ids: [], linking_complete: false }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(await accuracyDb().select().from(t.accuracyAssemblies).where(eq(t.accuracyAssemblies.workspace_id, seeded.scope.workspace_id))).toEqual([]);
    expect((await listClaims(seeded.scope.workspace_id)).some((row) => (row.metadata as Record<string, unknown>).history_only === true)).toBe(true);

    const assembly = await createAssembly({ workspace_id: seeded.scope.workspace_id, actor, source_file_ids: [seeded.scope.source_file_id],
      selections: [{ item_version_id: seeded.gapVersion.id, reason: "gap" }], mappings: [], coverage_run_ids: [], linking_complete: false });
    const deleted = await deleteWorkspace(seeded.scope.workspace_id);
    workspaces.splice(workspaces.indexOf(seeded.scope.workspace_id), 1);
    expect(deleted.deleted.assemblies).toBe(1);
    expect(deleted.deleted.assembly_items).toBe(1);
    expect(await readAssembly(seeded.scope.workspace_id, assembly.id)).toBeNull();
  });

  it("captures canonical identities once when later relationship decisions change the current group", async () => {
    const seeded = await seedMixed();
    const finalClaim = (await accuracyDb().select().from(t.accuracyClaims)
      .where(and(eq(t.accuracyClaims.workspace_id, seeded.scope.workspace_id), eq(t.accuracyClaims.id, seeded.finalGap.id))))[0];
    const draftClaim = (await accuracyDb().select().from(t.accuracyClaims)
      .where(and(eq(t.accuracyClaims.workspace_id, seeded.scope.workspace_id), eq(t.accuracyClaims.id, seeded.gapVersion.claim_id))))[0];
    expect(draftClaim.id).not.toBe(finalClaim.id);
    const assembly = await createAssembly({ workspace_id: seeded.scope.workspace_id, actor, source_file_ids: [seeded.scope.source_file_id],
      selections: [{ item_version_id: seeded.gapVersion.id, reason: "draft before canonical decision" }],
      mappings: [], coverage_run_ids: [], linking_complete: false });
    const [proposal] = await accuracyDb().select().from(t.accuracyItemRelationshipProposals)
      .where(eq(t.accuracyItemRelationshipProposals.workspace_id, seeded.scope.workspace_id));
    expect(proposal).toMatchObject({ predecessor_ids: [draftClaim.id], successor_ids: [finalClaim.id] });
    await decideItemRelationship({ workspace_id: seeded.scope.workspace_id, proposal_id: proposal.id,
      action: "confirm", rationale: "Same item", actor });

    const read = await readAssembly(seeded.scope.workspace_id, assembly.id);
    expect(read?.items[0]?.canonical_claim_id).toBe(draftClaim.id);
    expect((await resolveAssemblyItems(seeded.scope.workspace_id, [{ item_version_id: seeded.gapVersion.id, reason: "now" }]))[0]?.canonical_claim_id)
      .toBe(finalClaim.id);
  });

  it("saves valid-origin malformed raw provenance as a blocked inspectable assembly", async () => {
    const scope = await fixture();
    const malformedRaw = { id: "gap-malformed", statement: "Malformed raw quote", external_id: null,
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id }] };
    const finalGap = gap(scope, "Final source-backed gap");
    const final = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [finalGap] };
    const run_id = await extractionRun(scope, "gap", [{ ...final, gaps: [malformedRaw] }], final);
    await publishGeneratedItemHistory({ ...scope, run_id, claim_type: "gap", final_claims: [{
      id: finalGap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: finalGap.statement,
    }] });
    const versions = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(and(eq(t.accuracyItemVersions.workspace_id, scope.workspace_id), eq(t.accuracyItemVersions.item_index, 0)));
    const version = versions.find(row => (row.payload as Record<string, unknown>).statement === malformedRaw.statement);

    const assembly = await createAssembly({ workspace_id: scope.workspace_id, actor, source_file_ids: [scope.source_file_id],
      selections: [{ item_version_id: version!.id, reason: "raw malformed but retained" }],
      mappings: [], coverage_run_ids: [], linking_complete: true, generation_key: "malformed:raw" });

    expect(assembly.output.gaps).toEqual([malformedRaw]);
    expect(assembly.checks.status).toBe("blocked");
    expect(assembly.checks.findings.map(finding => finding.code)).toContain("malformed_provenance_span");
    expect((await readAssembly(scope.workspace_id, assembly.id))?.checks.status).toBe("blocked");
  });

  it("does not change downstream readers or validation state when creating an assembly", async () => {
    const seeded = await seedMixed();
    await applyClaimValidation({ workspace_id: seeded.scope.workspace_id, claim_ids: [seeded.finalGap.id],
      action: "validate", rationale: "Clinically reviewed source", actor });
    const beforeDownstream = await listDownstreamClaims(seeded.scope.workspace_id, { limit: null });
    const beforeValidation = await listClaims(seeded.scope.workspace_id);

    await createAssembly({ workspace_id: seeded.scope.workspace_id, actor, source_file_ids: [seeded.scope.source_file_id],
      selections: [{ item_version_id: seeded.gapVersion.id, reason: "review-only alternative" },
        { item_version_id: seeded.tacticVersion.id, reason: "selected tactic" }],
      mappings: [], coverage_run_ids: [], linking_complete: false });

    expect(await listDownstreamClaims(seeded.scope.workspace_id, { limit: null })).toEqual(beforeDownstream);
    expect((await listClaims(seeded.scope.workspace_id)).map(row => [row.id, row.status, row.validated, row.metadata]))
      .toEqual(beforeValidation.map(row => [row.id, row.status, row.validated, row.metadata]));
  });
});
