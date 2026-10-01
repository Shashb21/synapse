import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import { runAccuracyExperiment } from "@/accuracy/experiments/run";
import { runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { activeAccuracyModuleId, activateAccuracyModule, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { agenticModule, mechanicalModule } from "@/accuracy/modules/_factory";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { insertClaim } from "@/accuracy/store/claim-store";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { newId } from "@/modules/kernel/ids";

const createdWorkspaces: string[] = [];
const originals = new Map<string, string>();

beforeAll(() => { registerAccuracyStack(); });
afterEach(async () => {
  for (const [call_kind, module_id] of originals) {
    activateAccuracyModule({ call_kind: call_kind as never, module_id, activated_by: "experiment test restore" });
  }
  originals.clear();
  for (const workspace_id of createdWorkspaces.splice(0)) await deleteWorkspace(workspace_id);
});

async function sourceFixture() {
  const org_id = await createOrganization(newId("experiment-org"));
  const workspace_id = await createWorkspace({ org_id, name: "Experiment source", slug: newId("experiment-source") });
  createdWorkspaces.push(workspace_id);
  const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("checksum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Source evidence." }] });
  await insertClaim({ workspace_id, claim_type: "gap", statement: "Baseline context", source_file_id: source.id });
  return { org_id, workspace_id, source_file_id: source.id, block_id };
}

function activateControlledModule(args: { call_kind: "need_extract" | "inventory_extract"; run: (input: { workspace_id: string; source_file_id: string; block_id: string }, ctx: AccuracyModuleContext) => Promise<unknown> }) {
  const original = activeAccuracyModuleId(args.call_kind);
  if (original) originals.set(args.call_kind, original);
  const id = newId("experiment-module");
  const inputSchema = z.object({ workspace_id: z.string(), source_file_id: z.string(), block_id: z.string() });
  const outputSchema = args.call_kind === "need_extract"
    ? z.object({ gaps: z.array(z.object({ statement: z.string(), external_id: z.string().nullable().optional() })) })
    : z.object({ tactics: z.array(z.object({ name: z.string(), id: z.string() })) });
  registerAccuracyModule(mechanicalModule({ id, call_kind: args.call_kind, title: "Experiment test", summary: "Controlled test module", inputSchema, outputSchema: outputSchema as never, run: args.run as never }));
  activateAccuracyModule({ call_kind: args.call_kind, module_id: id, activated_by: "experiment test" });
}

describe("isolated accuracy experiments", () => {
  it("runs a remapped single call in a copied workspace and retains its evaluated snapshot", async () => {
    const source = await sourceFixture();
    let received: Record<string, unknown> | undefined;
    activateControlledModule({ call_kind: "need_extract", run: async (input) => {
      received = input;
      return { output: { gaps: [] }, summary: "controlled" };
    } });
    const originalInput = { workspace_id: "untrusted-client-workspace", source_file_id: source.source_file_id, block_id: source.block_id };

    const experiment = await runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: { temperature: 0 }, call: { call_kind: "need_extract", input: originalInput }, actor: { name: "test", function: "medical_affairs" } });
    createdWorkspaces.push(experiment.workspace_id);

    expect(received).toMatchObject({ workspace_id: experiment.workspace_id });
    expect(received).not.toMatchObject({ source_file_id: source.source_file_id, block_id: source.block_id });
    expect(experiment.status).toBe("completed");
    expect(experiment.calls).toEqual([expect.objectContaining({ call_kind: "need_extract", input: received, output: { gaps: [] } })]);
    expect(experiment.calls[0]?.call_id).toMatch(/^arun_/);
    expect(experiment.evaluations).toEqual([expect.objectContaining({ evaluation: expect.objectContaining({ pack_id: "beone-bgb-58067-prmt5i", status: "scored" }) })]);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracySourceFiles).where(eq(t.accuracySourceFiles.workspace_id, source.workspace_id))).toEqual([expect.objectContaining({ id: source.source_file_id, workspace_id: source.workspace_id })]);
  });

  it("retains a failed call and its model-error evaluation", async () => {
    const source = await sourceFixture();
    activateControlledModule({ call_kind: "need_extract", run: async () => { throw new Error("controlled output failure"); } });

    const experiment = await runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "need_extract", input: { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_id: source.block_id } }, actor: { name: "test", function: "medical_affairs" } });
    createdWorkspaces.push(experiment.workspace_id);

    expect(experiment.status).toBe("failed");
    expect(experiment.calls).toEqual([expect.objectContaining({ output: null, output_error: "controlled output failure" })]);
    expect(experiment.evaluations).toEqual([expect.objectContaining({ evaluation: expect.objectContaining({ status: "model_error", errors: ["controlled output failure"] }) })]);
  });

  it("rejects an unresolved workspace-owned input reference before calling the module", async () => {
    const source = await sourceFixture();
    let called = false;
    activateControlledModule({ call_kind: "need_extract", run: async () => {
      called = true;
      return { output: { gaps: [] }, summary: "unexpected" };
    } });

    await expect(runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "need_extract", input: { workspace_id: source.workspace_id, source_file_id: newId("src"), block_id: source.block_id } }, actor: { name: "test", function: "medical_affairs" } })).rejects.toThrow("Unresolved copied source_file_id");

    expect(called).toBe(false);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, source.workspace_id))).toEqual([]);
  });

  it("records experiment snapshots with experiment context while production defaults to production without gold payloads", async () => {
    const source = await sourceFixture();
    const original = activeAccuracyModuleId("inventory_extract");
    if (original) originals.set("inventory_extract", original);
    const id = newId("agentic-experiment-module");
    const inputSchema = z.object({ workspace_id: z.string(), source_file_id: z.string(), block_id: z.string() });
    registerAccuracyModule(agenticModule({ id, call_kind: "inventory_extract", title: "Agentic context test", summary: "Records one snapshot", inputSchema,
      outputSchema: z.object({ tactics: z.array(z.object({ name: z.string(), id: z.string() })) }),
      run: async (_input, ctx) => {
        await runShallowAgenticCycle({ run: ctx.run, maxExchanges: 0, onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }), proposer: async () => ({ tactics: [] }), critic: async () => ({ score: 1, issues: [] }), judge: async (draft) => draft });
        return { output: { tactics: [] }, summary: "agentic context" };
      } }));
    activateAccuracyModule({ call_kind: "inventory_extract", module_id: id, activated_by: "experiment test" });

    const production = await runAccuracyModule({ call_kind: "inventory_extract", workspace_id: source.workspace_id, org_id: source.org_id, input: { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_id: source.block_id }, actor: { name: "test", function: "medical_affairs" } });
    const experiment = await runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "inventory_extract", input: { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_id: source.block_id } }, actor: { name: "test", function: "medical_affairs" } });
    createdWorkspaces.push(experiment.workspace_id);
    const productionEvents = await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.run_id, production.run_id));
    const experimentEvents = await accuracyDb().select().from(t.accuracyAgentEvents).where(eq(t.accuracyAgentEvents.run_id, experiment.calls[0]!.call_id));
    const productionEvent = productionEvents.find((event) => (event.payload as { event_type?: string }).event_type === "snapshot");
    const experimentEvent = experimentEvents.find((event) => (event.payload as { event_type?: string }).event_type === "snapshot");

    expect(productionEvent?.payload).toMatchObject({ event_type: "snapshot", evaluation_context: "production" });
    expect(experimentEvent?.payload).toMatchObject({ event_type: "snapshot", evaluation_context: "experiment" });
    for (const event of [...productionEvents, ...experimentEvents]) {
      expect(event?.payload).not.toHaveProperty("gold");
      expect(event?.payload).not.toHaveProperty("metrics");
    }
  });

  it("retains snapshots and the resolved route when an agentic critic fails", async () => {
    const source = await sourceFixture();
    const original = activeAccuracyModuleId("inventory_extract");
    if (original) originals.set("inventory_extract", original);
    const id = newId("failing-agentic-module");
    const inputSchema = z.object({ workspace_id: z.string(), source_file_id: z.string(), block_id: z.string() });
    registerAccuracyModule(agenticModule({ id, call_kind: "inventory_extract", title: "Failing agentic context test", summary: "Records then fails", inputSchema,
      outputSchema: z.object({ tactics: z.array(z.object({ name: z.string(), id: z.string() })) }),
      run: async (_input, ctx) => {
        await runShallowAgenticCycle({ run: ctx.run, maxExchanges: 0, onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }), proposer: async () => ({ tactics: [] }), critic: async () => { throw new Error("critic failed after snapshot"); }, judge: async (draft) => draft });
        return { output: { tactics: [] }, summary: "unreachable" };
      } }));
    activateAccuracyModule({ call_kind: "inventory_extract", module_id: id, activated_by: "experiment test" });

    const experiment = await runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "inventory_extract", input: { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_id: source.block_id } }, actor: { name: "test", function: "medical_affairs" } });
    createdWorkspaces.push(experiment.workspace_id);
    const [moduleRun] = await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.id, experiment.calls[0]!.call_id));

    expect(experiment.status).toBe("failed");
    expect(experiment.calls).toHaveLength(2);
    expect(experiment.calls.map((call) => [call.version_index, call.output_error])).toEqual([[0, null], [1, "critic failed after snapshot"]]);
    expect(experiment.evaluations.map((row) => (row.evaluation as { status: string }).status)).toEqual(["scored", "model_error"]);
    expect(experiment.calls[1]?.route).toEqual(moduleRun?.route);
  });

  it("remaps coverage block bundles so the module reads copied evidence", async () => {
    const source = await sourceFixture();
    const original = activeAccuracyModuleId("coverage_decide");
    if (original) originals.set("coverage_decide", original);
    const id = newId("coverage-remap-module");
    let received: Record<string, unknown> | undefined;
    registerAccuracyModule(mechanicalModule({ id, call_kind: "coverage_decide", title: "Coverage remap test", summary: "Reads the copied bundle",
      inputSchema: z.object({ workspace_id: z.string(), gap_id: z.string(), tactic_id: z.string(), block_bundle_ids: z.array(z.string()) }),
      outputSchema: z.object({ read_count: z.number() }), run: async (input) => {
        received = input;
        const blocks = await readParseBlocksByIds(input.workspace_id, input.block_bundle_ids);
        return { output: { read_count: blocks.length }, summary: "copied blocks read" };
      } }));
    activateAccuracyModule({ call_kind: "coverage_decide", module_id: id, activated_by: "experiment test" });
    const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id));
    const request = { workspace_id: source.workspace_id, gap_id: claims[0]!.id, tactic_id: claims[0]!.id, block_bundle_ids: [source.block_id] };

    const experiment = await runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "coverage_decide", input: request }, actor: { name: "test", function: "medical_affairs" } });
    createdWorkspaces.push(experiment.workspace_id);

    expect(received).toMatchObject({ workspace_id: experiment.workspace_id, block_bundle_ids: [expect.not.stringMatching(source.block_id)] });
    expect(experiment.calls[0]?.output).toEqual({ read_count: 1 });
    expect(request).toEqual({ workspace_id: source.workspace_id, gap_id: claims[0]!.id, tactic_id: claims[0]!.id, block_bundle_ids: [source.block_id] });
  });

  it("creates independent attempts for identical immutable requests", async () => {
    const source = await sourceFixture();
    activateControlledModule({ call_kind: "need_extract", run: async () => ({ output: { gaps: [] }, summary: "repeat" }) });
    const input = { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_id: source.block_id };
    const request = { mode: "single_call" as const, source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: { temperature: 0 }, call: { call_kind: "need_extract" as const, input }, actor: { name: "test", function: "medical_affairs" as const } };

    const [first, second] = await Promise.all([runAccuracyExperiment(request), runAccuracyExperiment(request)]);
    createdWorkspaces.push(first.workspace_id, second.workspace_id);

    expect(first.id).not.toBe(second.id);
    expect(first.workspace_id).not.toBe(second.workspace_id);
    expect(first.calls[0]?.call_id).not.toBe(second.calls[0]?.call_id);
    expect(first.evaluations[0]?.id).not.toBe(second.evaluations[0]?.id);
    expect(input).toEqual({ workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_id: source.block_id });
  });

  it("rejects an unknown status-derive gap reference before the copied module can run", async () => {
    const source = await sourceFixture();

    await expect(runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "status_derive", input: { workspace_id: source.workspace_id, gap_ids: [newId("gap")], tactics: [{ id: newId("tac"), status: "planned" }], coverages: [{ gap_id: newId("gap"), tactic_id: newId("tac"), overall: "full", validated: true }], persist: false } }, actor: { name: "test", function: "medical_affairs" } })).rejects.toThrow("Unresolved copied gap_ids");

    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, source.workspace_id))).toEqual([]);
  });

  it("remaps every status-derive claim reference into the copied workspace", async () => {
    const source = await sourceFixture();
    const tactic = await insertClaim({ workspace_id: source.workspace_id, claim_type: "tactic", statement: "Baseline tactic", source_file_id: source.source_file_id });
    const [gap] = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id));
    const original = activeAccuracyModuleId("status_derive");
    if (original) originals.set("status_derive", original);
    const id = newId("status-remap-module");
    let received: Record<string, unknown> | undefined;
    registerAccuracyModule(mechanicalModule({ id, call_kind: "status_derive", title: "Status remap test", summary: "Observes copied references",
      inputSchema: z.object({ workspace_id: z.string(), gap_ids: z.array(z.string()), tactics: z.array(z.object({ id: z.string(), status: z.string() })), coverages: z.array(z.object({ gap_id: z.string(), tactic_id: z.string(), overall: z.string(), validated: z.boolean() })), persist: z.boolean() }),
      outputSchema: z.object({ statuses: z.array(z.unknown()) }), run: async (input) => { received = input; return { output: { statuses: [] }, summary: "copied status input" }; } }));
    activateAccuracyModule({ call_kind: "status_derive", module_id: id, activated_by: "experiment test" });
    const input = { workspace_id: source.workspace_id, gap_ids: [gap!.id], tactics: [{ id: tactic.id, status: "planned" }], coverages: [{ gap_id: gap!.id, tactic_id: tactic.id, overall: "full", validated: true }], persist: false };

    const experiment = await runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "status_derive", input }, actor: { name: "test", function: "medical_affairs" } });
    createdWorkspaces.push(experiment.workspace_id);

    expect(received).toMatchObject({ workspace_id: experiment.workspace_id });
    expect(received?.gap_ids).not.toContain(gap!.id);
    expect((received?.tactics as Array<{ id: string }>)[0]?.id).not.toBe(tactic.id);
    expect((received?.coverages as Array<{ gap_id: string; tactic_id: string }>)[0]).not.toMatchObject({ gap_id: gap!.id, tactic_id: tactic.id });
    expect(input).toEqual({ workspace_id: source.workspace_id, gap_ids: [gap!.id], tactics: [{ id: tactic.id, status: "planned" }], coverages: [{ gap_id: gap!.id, tactic_id: tactic.id, overall: "full", validated: true }], persist: false });
  });

  it("terminalizes an experiment when failed-call evaluation persistence fails without hiding the module error", async () => {
    const source = await sourceFixture();
    activateControlledModule({ call_kind: "need_extract", run: async () => { throw new Error("primary module failure"); } });
    await accuracyDb().execute(sql.raw("CREATE OR REPLACE FUNCTION kan34_fail_evaluation_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected evaluation persistence failure'; END; $$"));
    await accuracyDb().execute(sql.raw("CREATE TRIGGER kan34_fail_evaluation_insert BEFORE INSERT ON accuracy_experiment_evaluations FOR EACH ROW EXECUTE FUNCTION kan34_fail_evaluation_insert()"));
    try {
      await expect(runAccuracyExperiment({ mode: "single_call", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "need_extract", input: { workspace_id: source.workspace_id, source_file_id: source.source_file_id, block_id: source.block_id } }, actor: { name: "test", function: "medical_affairs" } })).rejects.toThrow("primary module failure");
    } finally {
      await accuracyDb().execute(sql.raw("DROP TRIGGER IF EXISTS kan34_fail_evaluation_insert ON accuracy_experiment_evaluations"));
      await accuracyDb().execute(sql.raw("DROP FUNCTION IF EXISTS kan34_fail_evaluation_insert()"));
    }
    const [experiment] = await accuracyDb().select().from(t.accuracyExperiments).where(eq(t.accuracyExperiments.source_workspace_id, source.workspace_id));
    createdWorkspaces.push(experiment!.workspace_id);

    expect(experiment).toMatchObject({ status: "failed" });
    const calls = await accuracyDb().select().from(t.accuracyExperimentCalls).where(eq(t.accuracyExperimentCalls.experiment_id, experiment!.id));
    expect(calls).toEqual([expect.objectContaining({ output_error: "primary module failure" })]);
  });
});
