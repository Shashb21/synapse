import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { activateAccuracyModule, activeAccuracyModuleId, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import type { CoverageDecision } from "@/accuracy/modules/coverage-decide/schema";
import { generateExtractionAssembly } from "@/accuracy/kernel/assembly-generation";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { listAssemblies } from "@/accuracy/store/assembly-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { generatedItemFingerprint } from "@/accuracy/domain/item-history";
import { newId, nowIso } from "@/modules/kernel/ids";

const workspaces: string[] = [];
const originals = new Map<string, string>();
const actor = { name: "Assembly generator", function: "medical_affairs" as const };

beforeAll(() => { registerAccuracyStack(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [call_kind, module_id] of originals) activateAccuracyModule({ call_kind: call_kind as never, module_id, activated_by: "restore" });
  originals.clear();
  for (const workspace_id of workspaces.splice(0)) await deleteWorkspace(workspace_id);
});

async function fixture() {
  await ensureAccuracySchema();
  const org_id = await createOrganization(newId("assembly-gen-org"));
  const workspace_id = await createWorkspace({ org_id, name: "Assembly generation", slug: newId("assembly-gen") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test",
    blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null,
      text: "The registry closes the comparative evidence gap." }] });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

async function extractionRun(scope: Awaited<ReturnType<typeof fixture>>, claim_type: "gap" | "tactic", snapshots: unknown[], final: unknown, selected_iteration?: number) {
  const id = newId("arun");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: claim_type === "gap" ? "need_extract" : "inventory_extract", agent_role: "proposer",
    module_id: "test", module_version: "1", status: "ok", started_at: now, finished_at: now,
    actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id }, output: final, steps: [] });
  for (const [iteration, output] of snapshots.entries()) {
    await accuracyDb().insert(t.accuracyAgentEvents).values({ id: newId("event"), run_id: id, workspace_id: scope.workspace_id,
      event_type: "snapshot", iteration, payload: { event_type: "snapshot", iteration, output }, recorded_at: now });
  }
  if (selected_iteration !== undefined) {
    await accuracyDb().insert(t.accuracyAgentEvents).values({ id: newId("event"), run_id: id, workspace_id: scope.workspace_id,
      event_type: "judgment", iteration: selected_iteration, payload: { event_type: "judgment", selected_iteration, reason: "test selection" }, recorded_at: now });
  }
  return id;
}

function installCoverage(overall: CoverageDecision["overall"] = "partial", options?: { failFirst?: boolean; failAttempt?: number }) {
  const call_kind = "coverage_decide";
  const original = activeAccuracyModuleId(call_kind);
  if (original) originals.set(call_kind, original);
  const id = newId("coverage-module");
  let attempts = 0;
  registerAccuracyModule(mechanicalModule({ id, call_kind, title: "Generated coverage", summary: "Generated coverage",
    inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string(), tactic_id: z.string(), block_bundle_ids: z.array(z.string()),
      selected_versions: z.object({ gap_version_id: z.string(), tactic_version_id: z.string(),
        gap_payload: z.record(z.string(), z.unknown()), tactic_payload: z.record(z.string(), z.unknown()) }).optional() }),
    outputSchema: z.object({ gap_id: z.string(), tactic_id: z.string(), overall: z.enum(["full", "partial", "limited", "not_relevant"]),
      quote_block_ids: z.array(z.string()), confidence: z.number(), rationale: z.string() }),
    run: async input => {
      attempts += 1;
      if ((options?.failFirst && attempts === 1) || options?.failAttempt === attempts) throw new Error("transient coverage failure");
      return { output: { gap_id: input.gap_id, tactic_id: input.tactic_id, overall,
        quote_block_ids: overall === "not_relevant" ? [] : input.block_bundle_ids, confidence: 0.8, rationale: "Generated pairwise decision" },
        summary: "Generated coverage" };
    } }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "assembly generation test" });
}

describe("generateExtractionAssembly", () => {
  it("selects persisted judged versions, runs exact selected-version coverage, saves mappings, and retries by generation key", async () => {
    const scope = await fixture();
    installCoverage("partial");
    const rawGap = { id: "gap-final", statement: "Earlier gap text", external_id: "GAP-1",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "comparative evidence gap" }] };
    const judgedGap = { ...rawGap, statement: "Judged comparative evidence gap" };
    const finalGap = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [judgedGap] };
    const gapRun = await extractionRun(scope, "gap", [{ ...finalGap, gaps: [rawGap] }, finalGap], finalGap, 1);
    await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: judgedGap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: judgedGap.statement }] });

    const tactic = { id: "tactic-final", name: "Registry follow-up", type: "rwe_study", status: "planned",
      evidence_question: "Does follow-up close the gap?", origin: "inventory",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "registry closes" }] };
    const tacticFinal = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [tactic] };
    const tacticRun = await extractionRun(scope, "tactic", [], tacticFinal);
    await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic",
      final_claims: [{ id: tactic.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tactic.name }] });

    const assembly = await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun, tacticRun], generation_key: "batch:one" });

    expect(assembly.output).toEqual({ gaps: [judgedGap], tactics: [tactic] });
    expect(assembly.items.map(item => [item.claim_type, item.iteration])).toEqual([["gap", 1], ["tactic", null]]);
    expect(assembly.mappings).toEqual([{ gap_version_id: assembly.items[0]!.id, tactic_version_id: assembly.items[1]!.id }]);
    expect(assembly.coverage).toHaveLength(1);
    expect(assembly.coverage[0]?.input).toMatchObject({ gap_id: assembly.items[0]!.id, tactic_id: assembly.items[1]!.id,
      generation_context: { evaluation_context: "production" },
      selected_versions: { gap_version_id: assembly.items[0]!.id, tactic_version_id: assembly.items[1]!.id,
        gap_payload: judgedGap, tactic_payload: tactic } });
    expect(assembly.extraction_runs).toEqual([
      expect.objectContaining({ call_kind: "need_extract", run_id: gapRun, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" }),
      expect.objectContaining({ call_kind: "inventory_extract", run_id: tacticRun, source_file_id: scope.source_file_id, item_count: 1, outcome: "items", evaluation_context: "production" }),
    ]);
    expect(assembly.checks.status).toBe("passed");
    expect(await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun, tacticRun], generation_key: "batch:one" }))
      .toEqual(assembly);
    const coverageRuns = (await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id)))
      .filter(run => run.call_kind === "coverage_decide");
    expect(coverageRuns).toHaveLength(1);
    expect(await accuracyDb().select().from(t.accuracyCoverageJoins).where(eq(t.accuracyCoverageJoins.workspace_id, scope.workspace_id))).toEqual([]);
  });

  it("records all not_relevant pair outcomes without creating positive mappings, including empty sides", async () => {
    const scope = await fixture();
    installCoverage("not_relevant");
    const gap = { id: "gap-only", statement: "Gap only", external_id: null,
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "evidence gap" }] };
    const finalGap = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [gap] };
    const gapRun = await extractionRun(scope, "gap", [], finalGap);
    await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: gap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: gap.statement }] });
    const tactic = { id: "tactic-irrelevant", name: "Irrelevant registry", type: "rwe_study", status: "planned",
      evidence_question: "Unrelated question", origin: "inventory",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "registry closes" }] };
    const tacticFinal = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [tactic] };
    const tacticRun = await extractionRun(scope, "tactic", [], tacticFinal);
    await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic",
      final_claims: [{ id: tactic.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tactic.name }] });

    const assembly = await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun, tacticRun], generation_key: "batch:empty-side" });

    expect(assembly.output).toEqual({ gaps: [gap], tactics: [tactic] });
    expect(assembly.coverage).toHaveLength(1);
    expect(assembly.coverage[0]?.output).toMatchObject({ overall: "not_relevant" });
    expect(assembly.mappings).toEqual([]);
    expect(assembly.checks.status).toBe("passed");

    const empty = await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [], generation_key: "batch:empty" });
    expect(empty.output).toEqual({ gaps: [], tactics: [] });
    expect(empty.coverage).toEqual([]);
    expect(empty.extraction_runs).toEqual([]);
  });

  it("honors judged iteration before deterministic ties and final-only before snapshot fallback", async () => {
    const scope = await fixture();
    installCoverage("not_relevant");
    const gap = { id: "same-gap", statement: "Same judged gap", external_id: "GAP-SAME",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "comparative evidence gap" }] };
    const finalGap = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [gap] };
    const gapRun = await extractionRun(scope, "gap", [finalGap, { ...finalGap, gaps: [{ ...gap, statement: "Other gap" }] }, finalGap], finalGap, 2);
    await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: gap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: gap.statement }] });

    const tactic = { id: "same-tactic", name: "Same tactic", type: "rwe_study", status: "planned",
      evidence_question: "Does it close?", origin: "inventory",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "registry closes" }] };
    const tacticFinal = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [tactic] };
    const tacticRun = await extractionRun(scope, "tactic", [tacticFinal], tacticFinal);
    await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic",
      final_claims: [{ id: tactic.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tactic.name }] });
    const [snapshotVersion] = await accuracyDb().select().from(t.accuracyItemVersions)
      .where(eq(t.accuracyItemVersions.run_id, tacticRun));
    await accuracyDb().insert(t.accuracyItemVersions).values({ id: newId("iver"), workspace_id: scope.workspace_id,
      claim_id: snapshotVersion!.claim_id, run_id: tacticRun, snapshot_id: null, iteration: null, item_index: 0,
      origin_key: `manual-final:${tacticRun}`, claim_type: "tactic", fingerprint: generatedItemFingerprint("tactic", tactic),
      payload: tactic, source_file_id: scope.source_file_id, created_at: nowIso() });

    const assembly = await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun, tacticRun], generation_key: "batch:preference" });

    expect(assembly.items.find(item => item.claim_type === "gap")?.iteration).toBe(2);
    expect(assembly.items.find(item => item.claim_type === "tactic")?.iteration).toBeNull();
  });

  it("preserves a judged final payload whose generated id differs from an earlier same-fingerprint snapshot", async () => {
    const scope = await fixture();
    const snapshotGap = { id: "gap-snapshot-id", statement: "Judged text", external_id: "GAP-ID",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "comparative evidence gap" }] };
    const finalGap = { ...snapshotGap, id: "gap-final-id" };
    const output = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [finalGap] };
    const gapRun = await extractionRun(scope, "gap", [{ ...output, gaps: [snapshotGap] }], output);
    await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: finalGap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: finalGap.statement }] });

    const assembly = await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun], generation_key: "batch:changed-id" });

    expect(assembly.output.gaps).toEqual([finalGap]);
    expect(assembly.items[0]?.snapshot_id).toBeNull();
  });

  it("does not complete an assembly after failed coverage and retries with new failed-attempt evidence", async () => {
    const scope = await fixture();
    installCoverage("partial", { failAttempt: 2 });
    const gap = { id: "gap-retry", statement: "Retry gap", external_id: null,
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "evidence gap" }] };
    const tactic = { id: "tactic-retry", name: "Retry tactic", type: "rwe_study", status: "planned",
      evidence_question: "Retry?", origin: "inventory",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "registry closes" }] };
    const tacticTwo = { ...tactic, id: "tactic-retry-two", name: "Retry tactic two" };
    const gapRun = await extractionRun(scope, "gap", [], { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [gap] });
    const tacticRun = await extractionRun(scope, "tactic", [], { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [tactic, tacticTwo] });
    await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: gap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: gap.statement }] });
    await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic",
      final_claims: [
        { id: tactic.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tactic.name },
        { id: tacticTwo.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tacticTwo.name },
      ] });

    await expect(generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun, tacticRun], generation_key: "batch:retry" }))
      .rejects.toThrow("transient coverage failure");
    expect(await listAssemblies(scope.workspace_id)).toEqual([]);

    const assembly = await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun, tacticRun], generation_key: "batch:retry" });
    expect(assembly.coverage).toHaveLength(2);
    const coverageRuns = (await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id)))
      .filter(run => run.call_kind === "coverage_decide");
    expect(coverageRuns.map(run => run.status).sort()).toEqual(["error", "ok", "ok"]);
    expect(new Set(coverageRuns.map(run => run.id)).size).toBe(3);
  });

  it("labels coverage runs from copied experiments with experiment evaluation context", async () => {
    const scope = await fixture();
    installCoverage("not_relevant");
    const gap = { id: "gap-exp", statement: "Experiment gap", external_id: null,
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "evidence gap" }] };
    const tactic = { id: "tactic-exp", name: "Experiment tactic", type: "rwe_study", status: "planned",
      evidence_question: "Experiment?", origin: "inventory",
      provenance: [{ source_file_id: scope.source_file_id, block_id: scope.block_id, quote: "registry closes" }] };
    const gapRun = await extractionRun(scope, "gap", [], { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [gap] });
    const tacticRun = await extractionRun(scope, "tactic", [], { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, tactics: [tactic] });
    await accuracyDb().update(t.accuracyModuleRuns).set({ evaluation_context: "experiment" }).where(eq(t.accuracyModuleRuns.id, gapRun));
    await accuracyDb().update(t.accuracyModuleRuns).set({ evaluation_context: "experiment" }).where(eq(t.accuracyModuleRuns.id, tacticRun));
    await publishGeneratedItemHistory({ ...scope, run_id: gapRun, claim_type: "gap",
      final_claims: [{ id: gap.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap", statement: gap.statement }] });
    await publishGeneratedItemHistory({ ...scope, run_id: tacticRun, claim_type: "tactic",
      final_claims: [{ id: tactic.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "tactic", statement: tactic.name }] });

    const assembly = await generateExtractionAssembly({ workspace_id: scope.workspace_id, org_id: scope.org_id, actor,
      source_file_ids: [scope.source_file_id], extraction_run_ids: [gapRun, tacticRun], generation_key: "batch:experiment",
      requested_kinds: ["need_extract", "inventory_extract"], evaluation_context: "experiment" });

    expect(assembly.extraction_runs?.every(run => run.evaluation_context === "experiment")).toBe(true);
    const coverageRuns = (await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, scope.workspace_id)))
      .filter(run => run.call_kind === "coverage_decide");
    expect(coverageRuns).toHaveLength(1);
    expect(coverageRuns[0]).toMatchObject({ evaluation_context: "experiment" });
    expect(coverageRuns[0]?.input).toMatchObject({ generation_context: { evaluation_context: "experiment" } });
  });
});
