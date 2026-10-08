import { afterEach, expect, it, vi } from "vitest";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { publishGeneratedItemHistory, readItemHistory } from "@/accuracy/store/item-history-store";
import { listAssemblies } from "@/accuracy/store/assembly-store";
import { withAssemblyPreparation } from "@/accuracy/kernel/assembly-context";
import { newId, nowIso } from "@/modules/kernel/ids";
import { eq } from "drizzle-orm";
import { applyExtractionBatch, createExtractionBatch, resumeExtractionBatch } from "@/accuracy/store/extraction-batch-store";

import { POST } from "@/app/api/accuracy/extract/route";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { activateAccuracyModule, activeAccuracyModuleId, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import { needExtractOutputSchema } from "@/accuracy/modules/need-extract/module";
import { appendAgentEvent } from "@/accuracy/kernel/agent-events";
import { z } from "zod";
const identity = vi.hoisted(() => ({
  actor: { name: "Publication tester", function: "medical_affairs" as const },
  role: "medical_affairs" as const,
  signed_in: true,
  demo: false,
  subject: "publication-subject",
}));
vi.mock("@/modules/auth/request", () => ({ requestIdentity: async () => identity }));

const workspaces: string[] = [];
const actor = { name: "Contributor", function: "medical_affairs" as const };
const span = { source_file_id: "", block_id: "", quote: "Evidence" };

async function fixture() {
  const org_id = await createOrganization("history test");
  const workspace_id = await createWorkspace({ org_id, name: "history", slug: newId("slug") });
  await grantOrganizationAccess({ subject: identity.subject, org_id });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, org_id, filename: "input.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await accuracyDb().insert(t.accuracyParseBlocks).values({ id: block_id, workspace_id, source_file_id: source.id,
    index: 0, kind: "paragraph", heading: null, text: "Evidence", parser: "test", created_at: nowIso() });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

async function run(scope: Awaited<ReturnType<typeof fixture>>, outputs: unknown[], final: unknown) {
  const id = newId("run");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id, org_id: scope.org_id, workspace_id: scope.workspace_id,
    call_kind: "need_extract", agent_role: "proposer", module_id: "test", module_version: "1", status: "ok",
    started_at: now, finished_at: now, actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id }, output: final, steps: [] });
  for (const [iteration, output] of outputs.entries()) await accuracyDb().insert(t.accuracyAgentEvents).values({
    id: newId("event"), run_id: id, workspace_id: scope.workspace_id, event_type: "snapshot", iteration,
    payload: { event_type: "snapshot", iteration, output }, recorded_at: now,
  });
  return id;
}

function gap(scope: Awaited<ReturnType<typeof fixture>>, statement: string, id = newId("gap")) {
  return { id, statement, external_id: null, provenance: [{ ...span, source_file_id: scope.source_file_id, block_id: scope.block_id }] };
}

function extractionRequest(scope: Awaited<ReturnType<typeof fixture>>) {
  return { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, kinds: ["need"] };
}

afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });


it("rolls back publication and batch together, then publishes canonical judged IDs with retry-safe raw origins", async () => {
  const scope = await fixture();
  const intermediate = gap(scope, "Intermediate question"); const final = gap(scope, "Final question");
  const output = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: [final] };
  const run_id = await run(scope, [{ ...output, gaps: [intermediate] }, output], output);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
  const ids: string[] = [];
  const publish = () => publishGeneratedItemHistory({ ...scope, run_id, claim_type: "gap", final_claims: [{ id: final.id, workspace_id: scope.workspace_id, claim_type: "gap", statement: final.statement, source_file_id: scope.source_file_id }] });
  await expect(applyExtractionBatch(batch, [run_id], ids, async () => { await publish(); throw new Error("history write failed"); })).rejects.toThrow("history write failed");
  expect(await readItemHistory(scope.workspace_id, final.id)).toBeNull();
  const [unapplied] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.id, batch.id));
  expect(unapplied.drafts_persisted).toBe(false);
  await applyExtractionBatch(batch, [run_id], ids, async () => { ids.push(...(await publish()).claim_ids); });
  const [applied] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.id, batch.id));
  expect(applied.created_claim_ids).toEqual([final.id]);
  await publish();
  expect((await readItemHistory(scope.workspace_id, final.id))?.versions).toHaveLength(1);
  const rows = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, scope.workspace_id));
  expect(rows).toHaveLength(2);
  expect((rows.find(row => row.id !== final.id)?.metadata as Record<string, unknown>)?.history_only).toBe(true);
});

it("retains duplicate raw snapshots but refuses ambiguous source identities before complete publication", async () => {
  registerAccuracyStack(); const scope = await fixture();
  const original = activeAccuracyModuleId("need_extract")!;
  const id = newId("extract-history"); const judged = gap(scope, "Final judged question");
  registerAccuracyModule(mechanicalModule({ id, call_kind: "need_extract", title: "Test", summary: "Test", inputSchema: z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()) }), outputSchema: needExtractOutputSchema,
    run: async (input, context) => {
      const base = { workspace_id: input.workspace_id, source_file_id: input.source_file_id };
      await appendAgentEvent({ workspace_id: input.workspace_id, run_id: context.run.id, event: { latency_ms: 0, cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, evaluation_context: "production", signals: { quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }, event_type: "snapshot", iteration: 0, output: { ...base, gaps: [gap(scope, "Intermediate alternative")] } } });
      const output = { ...base, gaps: [judged, { ...judged, id: newId("gap") }] };
      await appendAgentEvent({ workspace_id: input.workspace_id, run_id: context.run.id, event: { latency_ms: 0, cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, evaluation_context: "production", signals: { quote_validity: { valid_count: 1, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }, event_type: "snapshot", iteration: 1, output } });
      return { output: needExtractOutputSchema.parse(output), summary: "Two final outputs" };
    } }));
  activateAccuracyModule({ call_kind: "need_extract", module_id: id, activated_by: "test" });
  try {
    const response = await POST(new Request("http://localhost/api/accuracy/extract", { method: "POST", body: JSON.stringify(extractionRequest(scope)) }));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body).toMatchObject({ incomplete: true, gaps_inserted: 0, source_progress: { full_source_complete: false } });
    expect(body.runs[0].rejected_candidates).toEqual([
      { field: "identity", index: 0, reason: "ambiguous_source_identity" },
      { field: "identity", index: 1, reason: "ambiguous_source_identity" },
    ]);
    expect(await listAssemblies(scope.workspace_id)).toEqual([]);
    const snapshots = await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.run_id, body.runs[0].run_id));
    expect(snapshots.filter(row => row.event_type === "snapshot")).toHaveLength(2);
    const [batch] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.id, body.extraction_batch_id));
    expect(batch.created_claim_ids).toEqual([]);
    expect(await readItemHistory(scope.workspace_id, judged.id)).toBeNull();
  } finally { activateAccuracyModule({ call_kind: "need_extract", module_id: original, activated_by: "restore" }); }
});


it("preserves distinct generated questions through persisted publication and downstream resume despite legacy identity hints", async () => {
  const scope = await fixture(); registerAccuracyStack();
  const items = [gap(scope, "What is the long-term safety?"), gap(scope, "What is the comparative efficacy?")]
    .map(item => ({ ...item, external_id: "G:17" }));
  const output = { workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, gaps: items };
  const { insertClaim, getClaimsByIds, updateClaimMetadata } = await import("@/accuracy/store/claim-store");
  // This legacy row predates the managed extraction head.
  const legacy = await insertClaim({ workspace_id: scope.workspace_id, claim_type: "gap",
    statement: items[0].statement, metadata: { external_id: "G:17", provenance: items[0].provenance } });
  const run_id = await run(scope, [], output);
  const batch = await createExtractionBatch(scope.workspace_id, scope.source_file_id, ["need_extract"]);
  const ids: string[] = [];
  await applyExtractionBatch(batch, [run_id], ids, async () => {
    ids.push(...(await publishGeneratedItemHistory({ ...scope, run_id, claim_type: "gap", final_claims: items.map(item => ({
      id: item.id, workspace_id: scope.workspace_id, source_file_id: scope.source_file_id, claim_type: "gap",
      statement: item.statement, metadata: { external_id: item.external_id, provenance: item.provenance },
    })) })).claim_ids);
  });
  // Duplicate legacy identity hints make this proposal unapprovable under KAN38.
  // Inspect its retained raw history through the trusted preparation path.
  await withAssemblyPreparation(() => updateClaimMetadata({ workspace_id: scope.workspace_id, claim_id: items[0].id,
    metadata: { external_id: "G:17", provenance: items[0].provenance } }));
  const execute: Parameters<typeof resumeExtractionBatch>[0]["execute"] = async (_batch, _journal, prepared_merge) => (await runAccuracyModule<{ merged: number; survivors: number }>({
    ...scope, actor, prepared_merge, reserved_run_id: _journal.merge_operation_id, call_kind: "merge_dedupe", agent_role: "none", input: { workspace_id: scope.workspace_id },
  })).output;
  const resumed = await withAssemblyPreparation(() => resumeExtractionBatch({ ...scope, batch_id: batch.id, merge_context: { org_id: scope.org_id, actor }, execute }));
  expect(resumed).toMatchObject({ merged: 0, survivors: 3 });
  expect(await withAssemblyPreparation(() => resumeExtractionBatch({ ...scope, batch_id: batch.id, merge_context: { org_id: scope.org_id, actor }, execute }))).toEqual(resumed);
  expect((await withAssemblyPreparation(() => getClaimsByIds(scope.workspace_id, [...ids, legacy.id]))).every(row => row.status !== "merged")).toBe(true);
  for (const item of items) {
    const history = await readItemHistory(scope.workspace_id, item.id);
    expect(history?.canonical_claim_id).toBe(item.id);
    expect(history?.versions).toHaveLength(1);
    expect(history?.versions[0]).toMatchObject({ claim_id: item.id, run_id, payload: item });
    expect(history?.relationships).toEqual([]);
  }
});
