import { afterEach, describe, expect, it } from "vitest";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { createExperiment, exportExperiments, finishExperiment, getExperiment, recordExperimentCall, recordVersionEvaluation } from "@/accuracy/experiments/records";

const workspaces: string[] = [];
async function fixture() {
  const org_id = await createOrganization("experiment-records");
  const workspace_id = await createWorkspace({ org_id, name: "experiment", slug: `experiment-${Date.now()}-${Math.random()}` });
  workspaces.push(workspace_id);
  return { org_id, workspace_id };
}
afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });

describe("experiment records", () => {
  it("keeps identical attempts, all call versions, and complete exports", async () => {
    const scope = await fixture();
    const base = { ...scope, source_workspace_id: "source", pack_id: "beone-bgb-58067-prmt5i", pack_fingerprint: "pack", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: { sources: [] }, condition: { temperature: 0 } };
    const first = await createExperiment(base);
    const second = await createExperiment(base);
    expect(second.id).not.toBe(first.id);
    const call = await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "run-1", call_kind: "need_extract", version_index: 0, input: { source_file_id: "copy" }, output: { gaps: [] }, module_version: "need-v1", route: { model: "test" } });
    await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: call.call_id, version_index: 0, evaluation: { evaluator_version: "experiment-evaluator-v1", outcomes: [] } });
    await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "run-1", call_kind: "need_extract", version_index: 1, input: { source_file_id: "copy" }, output: { gaps: [] }, module_version: "need-v1", route: { model: "test" } });
    await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: call.call_id, version_index: 1, evaluation: { evaluator_version: "experiment-evaluator-v1", outcomes: [] } });
    await finishExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id, status: "completed" });

    const record = await getExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id });
    expect(record?.calls.map((row) => [row.call_id, row.version_index])).toEqual([["run-1", 0], ["run-1", 1]]);
    expect(record?.evaluations.map((row) => row.version_index)).toEqual([0, 1]);
    const json = await exportExperiments({ workspace_id: scope.workspace_id, format: "json" });
    const jsonl = await exportExperiments({ workspace_id: scope.workspace_id, format: "jsonl" });
    expect(JSON.parse(json)).toHaveLength(2);
    expect(jsonl.trim().split("\n").map((line) => JSON.parse(line))).toHaveLength(2);
  });

  it("rejects reads outside the owning workspace", async () => {
    const owner = await fixture(); const other = await fixture();
    const record = await createExperiment({ ...owner, source_workspace_id: "source", pack_id: "beone-bgb-58067-prmt5i", pack_fingerprint: "pack", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    expect(await getExperiment({ workspace_id: other.workspace_id, experiment_id: record.id })).toBeNull();
    await expect(recordExperimentCall({ workspace_id: other.workspace_id, experiment_id: record.id, call_id: "cross", call_kind: "need_extract", version_index: 0, input: {}, output: {}, module_version: "v1", route: {} })).rejects.toThrow("Unknown experiment");
  });
});
