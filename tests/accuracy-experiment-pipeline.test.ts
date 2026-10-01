/** End-to-end isolated extraction-pipeline experiment behavior. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import { runAccuracyExperiment } from "@/accuracy/experiments/run";
import { activeAccuracyModuleId, activateAccuracyModule, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { mechanicalModule } from "@/accuracy/modules/_factory";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { accuracyDb } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { newId } from "@/modules/kernel/ids";

const workspaces: string[] = [];
const originals = new Map<string, string>();

beforeAll(() => { registerAccuracyStack(); });
afterEach(async () => {
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

function controlled(call_kind: "inventory_extract" | "need_extract" | "merge_dedupe" | "status_derive", run: (input: Record<string, unknown>) => Promise<unknown>) {
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
  registerAccuracyModule(mechanicalModule({ id, call_kind, title: "Controlled pipeline", summary: "Controlled pipeline module", inputSchema: schemas[call_kind], outputSchema: outputs[call_kind] as never, run: async (input) => ({ output: await run(input as Record<string, unknown>), summary: call_kind }) }));
  activateAccuracyModule({ call_kind, module_id: id, activated_by: "pipeline test" });
}

describe("isolated extraction-pipeline experiments", () => {
  it("persists extracted drafts in the copy before downstream stages and retains evaluations", async () => {
    const source = await sourceFixture();
    const calls: string[] = [];
    controlled("inventory_extract", async (input) => { calls.push("inventory"); return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, tactics: [{ id: newId("tactic"), name: "Tactic", type: "access", status: "planned", evidence_question: "Evidence?", provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "Source evidence." }] }] }; });
    controlled("need_extract", async (input) => { calls.push("need"); return { workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [{ id: newId("gap"), statement: "Gap", external_id: "gap-1", provenance: [{ source_file_id: input.source_file_id, block_id: (input.block_ids as string[])[0], quote: "Source evidence." }] }] }; });
    controlled("merge_dedupe", async (input) => { calls.push("merge"); const claims = await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, input.workspace_id as string)); expect(claims.map(c => c.statement)).toEqual(expect.arrayContaining(["Gap", "Tactic"])); return { workspace_id: input.workspace_id, merged: 0, survivors: claims.length, contradictions: 0, merges: [], contradiction_rows: [] }; });
    controlled("status_derive", async (input) => { calls.push("status"); return { statuses: [], open: 0, partial: 0, addressed: 0 }; });

    const request = { mode: "pipeline" as const, source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "test", function: "medical_affairs" as const } };
    const experiment = await runAccuracyExperiment(request);
    const repeated = await runAccuracyExperiment(request);
    workspaces.push(experiment.workspace_id, repeated.workspace_id);

    expect(calls).toEqual(["inventory", "need", "merge", "status", "inventory", "need", "merge", "status"]);
    expect(experiment.status).toBe("completed");
    expect(experiment.calls.map(call => call.call_kind)).toEqual(["inventory_extract", "need_extract", "merge_dedupe", "status_derive"]);
    expect(experiment.evaluations).toHaveLength(4);
    expect(repeated.id).not.toBe(experiment.id);
    expect(repeated.workspace_id).not.toBe(experiment.workspace_id);
    expect(repeated.calls.map(call => call.call_id)).not.toEqual(experiment.calls.map(call => call.call_id));
    expect(repeated.evaluations.map(row => row.id)).not.toEqual(experiment.evaluations.map(row => row.id));
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id))).toEqual([]);
    expect(await accuracyDb().select().from(t.accuracyModuleRuns).where(eq(t.accuracyModuleRuns.workspace_id, source.workspace_id))).toEqual([]);
  });

  it("retains a failed downstream stage and its reserved journal in the copy", async () => {
    const source = await sourceFixture();
    const extractor = async (input: Record<string, unknown>) => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, gaps: [], });
    controlled("inventory_extract", async input => ({ workspace_id: input.workspace_id, source_file_id: input.source_file_id, tactics: [] }));
    controlled("need_extract", extractor);
    controlled("merge_dedupe", async () => { throw new Error("controlled merge failure"); });
    controlled("status_derive", async () => ({ statuses: [], open: 0, partial: 0, addressed: 0 }));

    const experiment = await runAccuracyExperiment({ mode: "pipeline", source_workspace_id: source.workspace_id, source_file_ids: [source.source_file_id], pack_id: "beone-bgb-58067-prmt5i", condition: {}, actor: { name: "test", function: "medical_affairs" } });
    workspaces.push(experiment.workspace_id);
    const journals = await accuracyDb().select().from(t.accuracyResumeJournals).where(eq(t.accuracyResumeJournals.workspace_id, experiment.workspace_id));

    expect(experiment.status).toBe("failed");
    expect(experiment.calls).toEqual(expect.arrayContaining([expect.objectContaining({ call_kind: "merge_dedupe", output_error: "controlled merge failure" })]));
    expect(experiment.evaluations).toEqual(expect.arrayContaining([expect.objectContaining({ evaluation: expect.objectContaining({ status: "model_error" }) })]));
    expect(journals).toEqual([expect.objectContaining({ merge_state: "reserved", status_state: "reserved", final_response: null })]);
    expect(await accuracyDb().select().from(t.accuracyClaims).where(eq(t.accuracyClaims.workspace_id, source.workspace_id))).toEqual([]);
  });
});
