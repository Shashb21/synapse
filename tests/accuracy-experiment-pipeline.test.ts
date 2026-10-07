/** End-to-end isolated extraction-pipeline experiment behavior. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import * as records from "@/accuracy/experiments/records";
import { runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import { inventoryExtractModule } from "@/accuracy/modules/inventory-extract/module";
import { runAccuracyExperiment } from "@/accuracy/experiments/run";
import { activeAccuracyModuleId, activateAccuracyModule, registerAccuracyModule } from "@/accuracy/kernel/registry";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { agenticModule, mechanicalModule } from "@/accuracy/modules/_factory";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { accuracyDb, accuracyTransactionActive } from "@/accuracy/store/db";
import { listClaims, claimMetadata } from "@/accuracy/store/claim-store";
import { listAccuracyRuns } from "@/accuracy/kernel/observability";
import { ExtractionBatchError, resumeExtractionBatch } from "@/accuracy/store/extraction-batch-store";
import { IncompleteAnswerError } from "@/modules/kernel/stage-errors";
import { accuracyRouteConfig, setAccuracyRouteConfig } from "@/accuracy/kernel/routing";
import { openAi, ProviderError, type LlmRequest } from "@/modules/llm/provider";
import { INVENTORY_PROPOSER_SYSTEM } from "@/accuracy/modules/inventory-extract/prompts";
import { NEED_PROPOSER_SYSTEM } from "@/accuracy/modules/need-extract/prompts";
import { MERGE_EQUIVALENCE_SYSTEM } from "@/accuracy/modules/merge-dedupe/prompts";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { newId } from "@/modules/kernel/ids";

const workspaces: string[] = [];
const originals = new Map<string, string>();

beforeAll(() => { registerAccuracyStack(); });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [call_kind, module_id] of originals) activateAccuracyModule({ call_kind: call_kind as never, module_id, activated_by: "pipeline test restore" });
  originals.clear();
  for (const workspace_id of workspaces.splice(0)) await deleteWorkspace(workspace_id);
});

async function sourceFixture() {
  const org_id = await createOrganization(newId("pipeline-org"));
  const workspace_id = await createWorkspace({ org_id, name: "Pipeline source", slug: newId("pipeline-source") });
  workspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("checksum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Source evidence." }] });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

async function addSource(args: { workspace_id: string; org_id: string; filename: string }) {
  const source = await insertSourceFile({ workspace_id: args.workspace_id, org_id: args.org_id, filename: args.filename, mime: "text/plain", checksum: newId("checksum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id: args.workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Second source evidence." }] });
  return { source_file_id: source.id, block_id };
}

function controlled(call_kind: "inventory_extract" | "need_extract" | "merge_dedupe" | "status_derive", run: (input: Record<string, unknown>, context: AccuracyModuleContext) => Promise<unknown>, agentic = false) {
  const original = activeAccuracyModuleId(call_kind);
  if (original) originals.set(call_kind, original);
  const schemas = {
    inventory_extract: z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()) }),
    need_extract: z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()) }),
    merge_dedupe: z.object({ workspace_id: z.string() }),
    status_derive: z.object({ workspace_id: z.string() }),
  };
  const outputs = {
    inventory_extract: z.object({ workspace_id: z.string(), source_file_id: z.string(), tactics: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), status: z.enum(["completed", "ongoing", "planned", "proposed", "cancelled"]), evidence_question: z.string(), provenance: z.array(z.object({ source_file_id: z.string(), block_id: z.string(), quote: z.string() })) })) }),
    need_extract: z.object({ workspace_id: z.string(), source_file_id: z.string(), gaps: z.array(z.object({ id: z.string(), statement: z.string(), external_id: z.string().nullable(), provenance: z.array(z.object({ source_file_id: z.string(), block_id: z.string(), quote: z.string() })) })) }),
    merge_dedupe: z.object({ workspace_id: z.string(), merged: z.number(), survivors: z.number(), contradictions: z.number(), merges: z.array(z.unknown()), contradiction_rows: z.array(z.unknown()) }),
    status_derive: z.object({ statuses: z.array(z.unknown()), open: z.number(), partial: z.number(), addressed: z.number() }),
  };
  const id = newId("pipeline-module");
  const createModule = agentic ? agenticModule : mechanicalModule;
  registerAccuracyModule(createModule({ id, call_kind, title: "Controlled pipeline", summary: "Controlled pipeline module", inputSchema: schemas[call_kind], outputSchema: outputs[call_kind] as never, run: async (input, context) => ({ output: await run(input as Record<string, unknown>, context), summary: call_kind }) }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "pipeline test" });
}

/** Script the provider only; extraction, completeness, merge and stores stay real. */
async function scriptedPipelineProvider<T>(judge: (request: LlmRequest) => Promise<string>, operation: () => Promise<T>) {
  const routes = await Promise.all((["inventory_extract", "need_extract", "merge_dedupe"] as const)
    .map(call_kind => accuracyRouteConfig(call_kind, call_kind === "merge_dedupe" ? "judge" : "proposer")));
  vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
  vi.stubEnv("OPENAI_API_KEY", "scripted-pipeline-provider");
  try {
    for (const route of routes) await setAccuracyRouteConfig({ ...route, provider_id: "openai", model: "gpt-5.1", fallbacks: [], actor_name: "test" });
    vi.spyOn(openAi, "complete").mockImplementation(async request => {
      expect(accuracyTransactionActive()).toBe(false);
      if (request.system === MERGE_EQUIVALENCE_SYSTEM) return judge(request);
      if (request.system.startsWith("Compare every source block")) {
        const { blocks } = JSON.parse(request.user) as { blocks: { id: string }[] };
        return JSON.stringify({ checked_block_ids: blocks.map(block => block.id), suspected_omissions: [], prior_issue_resolutions: [] });
      }
      const source_file_id = request.user.match(/source_file_id=(\S+)/)?.[1];
      const block_id = request.user.match(/### block_id=(\S+)/)?.[1];
      const provenance = [{ source_file_id, block_id, quote: "Source evidence." }];
      if (request.system === INVENTORY_PROPOSER_SYSTEM) return JSON.stringify({ tactics: [{ name: "Clinical comparator study",
        type: "phase3_trial", status: "planned", evidence_question: "Does it improve survival?", provenance }] });
      if (request.system === NEED_PROPOSER_SYSTEM) return JSON.stringify({ gaps: ["Need survival evidence", "Survival evidence is missing"]
        .map(statement => ({ statement, external_id: null, provenance })) });
      throw new Error("Unexpected provider request in scripted pipeline");
    });
    return await operation();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const route of routes) await setAccuracyRouteConfig({ ...route, actor_name: route.updated_by,
      temperature: route.params.temperature, max_tokens: route.params.max_tokens });
  }
}

describe("isolated extraction-pipeline experiments", () => {
  it("retains exhausted invalid merge judgments as an error version and evaluation without applying downstream effects", async () => {
    const source = await sourceFixture();
    let judgeCalls = 0;
    await scriptedPipelineProvider(async () => {
      judgeCalls++;
      return JSON.stringify({ decisions: [{ pair_id: "p1", same: "invalid boolean", rationale: "Invalid scripted judgment" }] });
    }, async () => {
      const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: source.workspace_id,
        source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {},
        actor: { name: "test", function: "medical_affairs" } });
      workspaces.push(experiment.workspace_id);
      expect(experiment.status).toBe("failed");
      expect(judgeCalls).toBe(3);
      const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, experiment.workspace_id));
      const errors = experiment.calls.filter(call => call.call_kind === "merge_dedupe");
      expect(errors).toEqual([expect.objectContaining({ call_id: journal.merge_operation_id, version_index: 0, output: null,
        output_error: expect.stringContaining("after 3 attempts"), input: { workspace_id: experiment.workspace_id } })]);
      expect(errors[0].output_error).toContain("complete dedupe decision");
      expect(experiment.evaluations.filter(row => row.call_id === journal.merge_operation_id)).toEqual([
        expect.objectContaining({ version_index: 0, evaluation: expect.objectContaining({ status: "model_error",
          output_shape: { valid: false }, errors: [errors[0].output_error] }) }),
      ]);
      expect(journal).toMatchObject({ merge_state: "reserved", status_state: "reserved", final_response: null,
        prepared_merge: null, preparation_token: null });
      expect((await listAccuracyRuns(experiment.workspace_id)).map(run => run.call_kind).sort()).toEqual(["inventory_extract", "need_extract"]);
      expect(experiment.calls.filter(call => call.call_kind === "status_derive")).toEqual([]);
      expect(experiment.calls.filter(call => call.call_kind !== "merge_dedupe").map(call => call.call_kind).sort())
        .toEqual(["inventory_extract", "need_extract"]);
      const claims = await listClaims(experiment.workspace_id);
      expect(claims).toHaveLength(3);
      expect(claims.filter(row => row.claim_type === "gap").map(row => row.status)).toEqual(["draft", "draft"]);
      for (const claim of claims) {
        expect(claimMetadata(claim)).not.toHaveProperty("merged_into");
        expect(claimMetadata(claim)).not.toHaveProperty("computed_status");
      }
      expect(await listClaims(source.workspace_id)).toEqual([]);
      const [batch] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.id, journal.batch_id));
      await expect(resumeExtractionBatch({ workspace_id: experiment.workspace_id, source_file_id: batch.source_file_id, batch_id: batch.id,
        merge_context: { org_id: experiment.org_id, actor: { name: "test", function: "medical_affairs" } },
        execute: async () => { throw new Error("Preparation failure must not reach apply"); } })).rejects.toBeInstanceOf(IncompleteAnswerError);
      expect(judgeCalls).toBe(6);
      expect(await listClaims(experiment.workspace_id)).toEqual(claims);
    });
  });

  it("does not notify a merge phase or invent an operation identity when reservation fails", async () => {
    const source = await sourceFixture();
    let phase: string | null = null;
    let applied = false;
    await expect(resumeExtractionBatch({ workspace_id: source.workspace_id, source_file_id: source.source_file_id, batch_id: "missing-batch",
      merge_context: { org_id: source.org_id, actor: { name: "test", function: "medical_affairs" } },
      onMergePreparation: journal => { phase = journal.merge_operation_id; },
      execute: async () => { applied = true; return {}; } })).rejects.toBeInstanceOf(ExtractionBatchError);
    expect(phase).toBeNull();
    expect(applied).toBe(false);
    expect(await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, source.workspace_id))).toEqual([]);
  });

  it("retains a merge preparation provider failure and evaluation under its reserved journal identity", async () => {
    const source = await sourceFixture();
    const failure = new ProviderError({ provider_id: "openai", provider_name: "OpenAI", key_env: "OPENAI_API_KEY",
      status: 402, error_type: "insufficient_quota", provider_message: "Scripted merge provider failure" });
    let judgeCalls = 0;
    await scriptedPipelineProvider(async () => { judgeCalls++; throw failure; }, async () => {
      const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: source.workspace_id,
        source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {},
        actor: { name: "test", function: "medical_affairs" } });
      workspaces.push(experiment.workspace_id);
      expect(experiment.status).toBe("failed");
      expect(judgeCalls).toBe(1);
      const [journal] = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, experiment.workspace_id));
      expect(journal).toMatchObject({ merge_state: "reserved", status_state: "reserved", final_response: null,
        prepared_merge: null, preparation_token: null });
      expect(experiment.calls.filter(call => call.call_kind === "merge_dedupe")).toEqual([
        expect.objectContaining({ call_id: journal.merge_operation_id, version_index: 0, output: null, output_error: failure.message,
          input: { workspace_id: experiment.workspace_id } }),
      ]);
      expect(experiment.evaluations.filter(row => row.call_id === journal.merge_operation_id)).toEqual([
        expect.objectContaining({ version_index: 0, evaluation: expect.objectContaining({ status: "model_error",
          output_shape: { valid: false }, errors: [failure.message] }) }),
      ]);
      expect(experiment.calls.filter(call => call.call_kind === "status_derive")).toEqual([]);
      const runs = await listAccuracyRuns(experiment.workspace_id);
      expect(runs.map(run => run.call_kind).sort()).toEqual(["inventory_extract", "need_extract"]);
      expect(runs.every(run => run.status === "ok")).toBe(true);
      const claims = await listClaims(experiment.workspace_id);
      expect(claims).toHaveLength(3);
      expect(claims.filter(row => row.claim_type === "gap").map(row => row.status)).toEqual(["draft", "draft"]);
      for (const claim of claims) {
        expect(claimMetadata(claim)).not.toHaveProperty("merged_into");
        expect(claimMetadata(claim)).not.toHaveProperty("computed_status");
      }
      expect(await listClaims(source.workspace_id)).toEqual([]);
      expect(experiment.calls.filter(call => call.call_kind !== "merge_dedupe").map(call => call.call_kind).sort())
        .toEqual(["inventory_extract", "need_extract"]);
      // Production resume keeps the same typed failure and reserved identity;
      // the experiment observer is optional and does not alter its error surface.
      const [batch] = await accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.id, journal.batch_id));
      let applied = false;
      await expect(resumeExtractionBatch({ workspace_id: experiment.workspace_id, source_file_id: batch.source_file_id, batch_id: batch.id,
        merge_context: { org_id: experiment.org_id, actor: { name: "test", function: "medical_affairs" } },
        execute: async () => { applied = true; return {}; } })).rejects.toBe(failure);
      expect(applied).toBe(false);
      expect(judgeCalls).toBe(2);
    });
  });
  it.each(["single_call", "pipeline"] as const)("propagates three fixed passes through the actual %s path and retains terminal assessments", async mode => {
    const source = await sourceFixture();
    const sourceRows = await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, source.workspace_id));
    const blockRows = await accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, source.workspace_id));
    for (const call_kind of ["inventory_extract", "need_extract"] as const) {
      controlled(call_kind, async (input, context) => {
        const result = await runShallowAgenticCycle({ run: context.run, maxExchanges: 0,
          onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }),
          proposer: async () => call_kind === "inventory_extract" ? { tactics: [] } : { gaps: [] },
          critic: async () => ({ score: 1, issues: [] }), judge: async draft => draft });
        return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, ...result.final };
      }, true);
    }
    controlled("merge_dedupe", async (input, context) => {
      expect(context.run).not.toHaveProperty("experiment_cycle_control", expect.anything());
      return { workspace_id: input.workspace_id, merged: 0, survivors: 0, contradictions: 0, merges: [], contradiction_rows: [] };
    });
    controlled("status_derive", async () => ({ statuses: [], open: 0, partial: 0, addressed: 0 }));
    const experiment = await runAccuracyExperiment({ mode, source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id],
      pack_id: "beone-bgb-58067-prmt5i", condition: { critic_revision_passes: 3 }, actor: { name: "test", function: "medical_affairs" },
      ...(mode === "single_call" ? { call: { call_kind: "inventory_extract" as const, input: { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_ids: [source.block_id] } } } : {}) });
    workspaces.push(experiment.workspace_id);
    expect(experiment.status).toBe("completed");
    expect(experiment.condition).toMatchObject({ critic_revision_passes: 3 });
    for (const call_kind of mode === "pipeline" ? ["inventory_extract", "need_extract"] : ["inventory_extract"]) {
      const calls = experiment.calls.filter(call => call.call_kind === call_kind);
      expect(calls.map(call => call.version_index)).toEqual([0, 1, 2, 3]);
      const progression = await readAgentProgression({ workspace_id: experiment.workspace_id, run_id: calls[0].call_id });
      expect(progression?.events.filter(row => row.event.event_type === "critique").map(row => row.event.event_type === "critique" && row.event.iteration)).toEqual([0, 1, 2, 3]);
      expect(progression?.events.at(-1)?.event).toMatchObject({ event_type: "judgment", selected_iteration: 3 });
    }
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, source.workspace_id))).toEqual(sourceRows);
    expect(await accuracyDb().select().from(t.accuracyParseBlocks).where(eq(t.accuracyParseBlocks.workspace_id, source.workspace_id))).toEqual(blockRows);
  });

  it.each(["single_call", "pipeline"] as const)("scores V0 and revision snapshots from the real inventory module in %s mode", async (mode) => {
    const source = await sourceFixture();
    const original = activeAccuracyModuleId("inventory_extract");
    if (original) originals.set("inventory_extract", original);
    const id = newId("real-inventory-controlled-completion");
    const name = "A source-backed clinical trial";
    registerAccuracyModule({ ...inventoryExtractModule, manifest: { ...inventoryExtractModule.manifest, id },
      run: async (rawInput, context) => {
        const input = inventoryExtractModule.inputSchema.parse(rawInput);
        vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
        try {
          return await inventoryExtractModule.run(input, { ...context, complete: async request => {
            const response = request.purpose === "snapshot_completeness"
              ? { checked_block_ids: input.block_ids, suspected_omissions: [], prior_issue_resolutions: [] }
              : { tactics: [{ name, type: "phase3_trial", status: "planned", evidence_question: "Does it work?",
                provenance: request.purpose.endsWith("r0") ? [] : [{ source_file_id: input.source_file_id, block_id: input.block_ids[0], quote: "Source evidence." }] }] };
            return { raw: JSON.stringify(response), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
          } });
        } finally { vi.unstubAllEnvs(); }
      } });
    activateAccuracyModule({ call_kind: "inventory_extract", module_id: id, activated_by: "regression test" });
    controlled("need_extract", async input => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [] }));
    controlled("merge_dedupe", async input => ({ workspace_id: input.workspace_id, merged: 0, survivors: 1, contradictions: 0, merges: [], contradiction_rows: [] }));
    controlled("status_derive", async () => ({ statuses: [], open: 0, partial: 0, addressed: 0 }));
    const experiment = await runAccuracyExperiment({ mode, source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id],
      pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "test", function: "medical_affairs" },
      ...(mode === "single_call" ? { call: { call_kind: "inventory_extract" as const,
        input: { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_ids: [source.block_id] } } } : {}) });
    workspaces.push(experiment.workspace_id);
    expect(experiment.status).toBe("completed");
    const calls = experiment.calls.filter(call => call.call_kind === "inventory_extract");
    expect(calls.map(call => call.version_index)).toEqual([0, 1]);
    for (const call of calls) {
      expect(call.output).toMatchObject({ tactics: [{ name }] });
      expect((call.output as { tactics: object[] }).tactics[0]).not.toHaveProperty("id");
      expect(experiment.evaluations.find(row => row.call_id === call.call_id && row.version_index === call.version_index)?.evaluation)
        .toMatchObject({ status: "scored", outcomes: expect.arrayContaining([expect.objectContaining({ model_item_index: 0, outcome: "wrong" })]) });
    }
  });

  it.each([0, 1, 2, 3])("retains every controlled snapshot and exports a separate error after critic failure at V%i", async (failedVersion) => {
    const source = await sourceFixture();
    controlled("inventory_extract", async (_input, context) => {
      await runShallowAgenticCycle({ run: context.run, maxExchanges: 0,
        onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }),
        proposer: async round => ({ tactics: [{ name: `Trial version ${round}` }] }),
        critic: async draft => {
          if (draft.tactics[0].name === `Trial version ${failedVersion}`) throw new Error("critic failed after snapshot");
          return { score: 1, issues: [] };
        }, judge: async draft => draft });
      throw new Error("unreachable");
    }, true);
    const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id],
      pack_id: "beone-bgb-58067-prmt5i", condition: { critic_revision_passes: 3 }, actor: { name: "test", function: "medical_affairs" } });
    workspaces.push(experiment.workspace_id);
    expect(experiment.status).toBe("failed");
    const versions = Array.from({ length: failedVersion + 1 }, (_, version) => version);
    expect(experiment.calls.map(call => ({ version: call.version_index, output: call.output, error: call.output_error }))).toEqual([
      ...versions.map(version => ({ version, output: { tactics: [{ name: `Trial version ${version}` }] }, error: null })),
      { version: failedVersion + 1, output: null, error: "critic failed after snapshot" },
    ]);
    expect(experiment.evaluations.map(row => (row.evaluation as { status: string }).status)).toEqual([...versions.map(() => "scored"), "model_error"]);
    const json = JSON.parse(await records.exportExperiments({ workspace_id: experiment.workspace_id, format: "json" }));
    const jsonl = (await records.exportExperiments({ workspace_id: experiment.workspace_id, format: "jsonl" })).trim().split("\n").map(line => JSON.parse(line));
    expect(json).toEqual([experiment]);
    expect(jsonl).toEqual(json);
  });

  it("recovers a partially retained version without duplicate calls after an evaluation write fails once", async () => {
    const source = await sourceFixture();
    const saveEvaluation = records.recordVersionEvaluation;
    vi.spyOn(records, "recordVersionEvaluation").mockRejectedValueOnce(new Error("transient evaluation write failure")).mockImplementation(saveEvaluation);
    controlled("inventory_extract", async (_input, context) => {
      const result = await runShallowAgenticCycle({ run: context.run, maxExchanges: 1,
        onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }),
        proposer: async () => ({ tactics: [] }), critic: async () => ({ score: 0, issues: [] }), judge: async draft => draft });
      return { workspace_id: _input.workspace_id, source_file_id: _input.source_file_id, ...result.final };
    }, true);
    const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id],
      pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "test", function: "medical_affairs" } });
    workspaces.push(experiment.workspace_id);
    expect(experiment.status).toBe("failed");
    expect(experiment.calls.map(call => call.version_index)).toEqual([0, 1, 2]);
    expect(experiment.calls[2].output_error).toBe("transient evaluation write failure");
    expect(experiment.evaluations.map(row => (row.evaluation as { status: string }).status)).toEqual(["scored", "scored", "model_error"]);
  });

  it("persists extracted drafts in the copy before downstream stages and retains evaluations", async () => {
    const source = await sourceFixture();
    const second = await addSource({ workspace_id: source.workspace_id, org_id: source.org_id, filename: "second.txt" });
    const calls: Array<{ stage: string; source_file_id?: string }> = [];
    controlled("inventory_extract", async (input) => { calls.push({ stage: "inventory", source_file_id: input.source_file_id as string }); return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, tactics: [{ id: newId("tactic"), name: "Tactic", type: "access", status: "planned", evidence_question: "Evidence?", provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "Source evidence." }] }] }; });
    controlled("need_extract", async (input) => { calls.push({ stage: "need", source_file_id: input.source_file_id as string }); return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [{ id: newId("gap"), statement: "Gap", external_id: "gap-1", provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "Source evidence." }] }] }; });
    controlled("merge_dedupe", async (input) => { calls.push({ stage: "merge" }); const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, input.workspace_id as string)); expect(claims.map(c => c.statement)).toEqual(expect.arrayContaining(["Gap", "Tactic"])); return { workspace_id: input.workspace_id, merged: 0, survivors: claims.length, contradictions: 0, merges: [], contradiction_rows: [] }; });
    controlled("status_derive", async () => { calls.push({ stage: "status" }); return { statuses: [], open: 0, partial: 0, addressed: 0 }; });

    const request = { mode: "pipeline" as const, source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id, second.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "test", function: "medical_affairs" as const } };
    const experiment = await runAccuracyExperiment(request);
    const repeated = await runAccuracyExperiment(request);
    workspaces.push(experiment.workspace_id, repeated.workspace_id);

    const firstCopiedSources = experiment.calls.filter(call => call.call_kind === "inventory_extract").map(call => (call.input as { source_file_id: string }).source_file_id);
    expect(firstCopiedSources).toHaveLength(2);
    expect(new Set(firstCopiedSources).size).toBe(2);
    expect(calls.slice(0, 8)).toEqual([
      { stage: "inventory", source_file_id: firstCopiedSources[0] }, { stage: "need", source_file_id: firstCopiedSources[0] }, { stage: "merge" }, { stage: "status" },
      { stage: "inventory", source_file_id: firstCopiedSources[1] }, { stage: "need", source_file_id: firstCopiedSources[1] }, { stage: "merge" }, { stage: "status" },
    ]);
    expect(calls.slice(8)).toEqual([
      { stage: "inventory", source_file_id: expect.any(String) }, { stage: "need", source_file_id: expect.any(String) }, { stage: "merge" }, { stage: "status" },
      { stage: "inventory", source_file_id: expect.any(String) }, { stage: "need", source_file_id: expect.any(String) }, { stage: "merge" }, { stage: "status" },
    ]);
    expect(experiment.status).toBe("completed");
    expect(experiment.calls.map(call => call.call_kind)).toEqual(["inventory_extract", "need_extract", "merge_dedupe", "status_derive", "inventory_extract", "need_extract", "merge_dedupe", "status_derive"]);
    expect(experiment.evaluations).toHaveLength(8);
    expect(repeated.id).not.toBe(experiment.id);
    expect(repeated.workspace_id).not.toBe(experiment.workspace_id);
    expect(repeated.calls.map(call => call.call_id)).not.toEqual(experiment.calls.map(call => call.call_id));
    expect(repeated.evaluations.map(row => row.id)).not.toEqual(experiment.evaluations.map(row => row.id));
    const [batches, journals] = await Promise.all([
      accuracyDb().select().from(t.accuracyExtractionBatches).where(eq(t.accuracyExtractionBatches.workspace_id, experiment.workspace_id)),
      accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, experiment.workspace_id)),
    ]);
    expect(batches).toHaveLength(2);
    expect(new Set(batches.map(batch => batch.source_file_id))).toEqual(new Set(firstCopiedSources));
    expect(journals).toHaveLength(2);
    expect(new Set(journals.map(journal => journal.batch_id))).toEqual(new Set(batches.map(batch => batch.id)));
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.workspace_id, source.workspace_id))).toEqual([]);
  });

  it("retains successful merge evidence when status fails and keeps the journal replayable", async () => {
    const source = await sourceFixture();
    const extractor = async (input: Record<string, unknown>) => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [], });
    controlled("inventory_extract", async input => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, tactics: [] }));
    controlled("need_extract", extractor);
    controlled("merge_dedupe", async input => ({ workspace_id: input.workspace_id, merged: 0, survivors: 0, contradictions: 0, merges: [], contradiction_rows: [] }));
    controlled("status_derive", async () => { throw new Error("controlled status failure"); });

    const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "test", function: "medical_affairs" } });
    workspaces.push(experiment.workspace_id);
    const journals = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, experiment.workspace_id));

    expect(experiment.status).toBe("failed");
    expect(experiment.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ call_kind: "merge_dedupe", output: expect.objectContaining({ merged: 0 }) }),
      expect.objectContaining({ call_kind: "status_derive", output_error: "controlled status failure" }),
    ]));
    expect(experiment.evaluations).toEqual(expect.arrayContaining([expect.objectContaining({ evaluation: expect.objectContaining({ status: "model_error" }) })]));
    expect(journals).toEqual([expect.objectContaining({ merge_state: "reserved", status_state: "reserved", final_response: null })]);
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id))).toEqual([]);
  });

  it("pauses the copied pipeline for an important extractor omission without touching the live workspace", async () => {
    const source = await sourceFixture();
    controlled("inventory_extract", async input => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, tactics: [] }));
    controlled("need_extract", async (input, context) => {
      await context.run.recordAgentEvent({ event_type: "critique", iteration: 0, score: 0,
        issues: [], completeness: { risk_level: "important", checked_block_ids: input.block_ids as string[], unchecked_block_ids: [],
          suspected_omissions: [{ issue_id: "missing-important", item_kind: "gap", summary: "Important missing gap",
            source_ref: { source_file_id: input.source_file_id as string, block_id: (input.block_ids as string[])[0]! }, evidence_quote: "Source evidence.",
            basis: "explicit", importance: "important", reason: "The source explicitly requires this gap.", suggested_action: "Review the gap." }], prior_issue_resolutions: [] },
        latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 });
      return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [] };
    }, true);
    controlled("merge_dedupe", async () => { throw new Error("merge must be skipped while paused"); });
    controlled("status_derive", async () => { throw new Error("status must be skipped while paused"); });

    const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: { critic_revision_passes: 3 }, actor: { name: "test", function: "medical_affairs" } });
    workspaces.push(experiment.workspace_id);
    const journals = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, experiment.workspace_id));

    expect(experiment.status).toBe("failed");
    expect(experiment.calls.map(call => call.call_kind)).toEqual(["inventory_extract", "need_extract"]);
    expect(journals).toEqual([expect.objectContaining({ merge_state: "reserved", status_state: "reserved", final_response: null })]);
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.workspace_id, source.workspace_id))).toEqual([]);
  });
});
