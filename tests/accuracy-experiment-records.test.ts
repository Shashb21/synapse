import { afterEach, describe, expect, it } from "vitest";
import { createOrganization, createWorkspace, deleteWorkspace } from "@/accuracy/store/tenant";
import { createExperiment, exportExperiments, finishExperiment, getExperiment, recordExperimentCall, recordVersionEvaluation } from "@/accuracy/experiments/records";
import { evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";

const workspaces: string[] = [];
async function fixture() {
  const org_id = await createOrganization("experiment-records");
  const source_workspace_id = await createWorkspace({ org_id, name: "source", slug: `source-${Date.now()}-${Math.random()}` });
  const workspace_id = await createWorkspace({ org_id, name: "experiment", slug: `experiment-${Date.now()}-${Math.random()}` });
  workspaces.push(source_workspace_id, workspace_id);
  return { org_id, workspace_id, source_workspace_id };
}
afterEach(async () => { for (const id of workspaces.splice(0)) await deleteWorkspace(id); });

describe("experiment records", () => {
  it("keeps identical attempts, all call versions, and complete exports", async () => {
    const scope = await fixture();
    const base = { ...scope, pack_id: "beone-bgb-58067-prmt5i", pack_fingerprint: "pack", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: { sources: [] }, condition: { temperature: 0 } };
    const first = await createExperiment(base);
    const second = await createExperiment(base);
    expect(second.id).not.toBe(first.id);
    const call = await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "run-1", call_kind: "need_extract", version_index: 0, input: { source_file_id: "copy" }, output: { gaps: [] }, module_version: "need-v1", route: { model: "test" } });
    await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: call.call_id, version_index: 0, evaluation: evaluateExperimentVersion({ pack_id: first.pack_id, call_kind: "need_extract", output: { gaps: [] } }) });
    await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "run-1", call_kind: "need_extract", version_index: 1, input: { source_file_id: "copy" }, output: { gaps: [] }, module_version: "need-v1", route: { model: "test" } });
    await recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: call.call_id, version_index: 1, evaluation: evaluateExperimentVersion({ pack_id: first.pack_id, call_kind: "need_extract", output: { gaps: [] } }) });
    await finishExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id, status: "completed" });

    const record = await getExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id });
    expect(record?.calls.map((row) => [row.call_id, row.version_index])).toEqual([["run-1", 0], ["run-1", 1]]);
    expect(record?.evaluations.map((row) => row.version_index)).toEqual([0, 1]);
    const json = await exportExperiments({ workspace_id: scope.workspace_id, format: "json" });
    const jsonl = await exportExperiments({ workspace_id: scope.workspace_id, format: "jsonl" });
    expect(JSON.parse(json)).toHaveLength(2);
    expect(jsonl.trim().split("\n").map((line) => JSON.parse(line))).toHaveLength(2);
    await expect(recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: first.id, call_id: "late", call_kind: "need_extract", version_index: 0, input: {}, output: {}, module_version: "v1", route: {} })).rejects.toThrow("terminal");
    await expect(finishExperiment({ workspace_id: scope.workspace_id, experiment_id: first.id, status: "failed" })).rejects.toThrow("terminal");
  });

  it("rejects reads outside the owning workspace", async () => {
    const owner = await fixture(); const other = await fixture();
    const record = await createExperiment({ ...owner, pack_id: "beone-bgb-58067-prmt5i", pack_fingerprint: "pack", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    expect(await getExperiment({ workspace_id: other.workspace_id, experiment_id: record.id })).toBeNull();
    await expect(recordExperimentCall({ workspace_id: other.workspace_id, experiment_id: record.id, call_id: "cross", call_kind: "need_extract", version_index: 0, input: {}, output: {}, module_version: "v1", route: {} })).rejects.toThrow("Unknown experiment");
  });

  it("rejects a missing source lineage and mismatched evaluation identities", async () => {
    const scope = await fixture();
    await expect(createExperiment({ ...scope, source_workspace_id: "missing", pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} })).rejects.toThrow("source workspace");
    const experiment = await createExperiment({ ...scope, pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    await recordExperimentCall({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", call_kind: "need_extract", version_index: 0, input: {}, output: { gaps: [] }, module_version: "v1", route: {} });
    const evaluation = evaluateExperimentVersion({ pack_id: experiment.pack_id, call_kind: "need_extract", output: { gaps: [] } });
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, evaluator_version: "wrong" } as never })).rejects.toThrow("evaluator");
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, pack_id: "beone-tislelizumab-iegp" } })).rejects.toThrow("pack");
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, pack_fingerprint: "wrong" } })).rejects.toThrow("fingerprint");
    await expect(recordVersionEvaluation({ workspace_id: scope.workspace_id, experiment_id: experiment.id, call_id: "run-identity", version_index: 0, evaluation: { ...evaluation, call_kind: "inventory_extract" } })).rejects.toThrow("call kind");
  });

  it("allows exactly one concurrent terminal transition", async () => {
    const scope = await fixture();
    const experiment = await createExperiment({ ...scope, pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "source", baseline_fingerprint: "baseline", baseline_snapshot: {}, condition: {} });
    const results = await Promise.allSettled([
      finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "completed" }),
      finishExperiment({ workspace_id: scope.workspace_id, experiment_id: experiment.id, status: "failed" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
