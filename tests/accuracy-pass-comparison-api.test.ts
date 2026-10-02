/** API integration with real authorization, input validation, copies and retained evidence. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAccuracyStack } from "@/accuracy";
import type { PassComparison } from "@/accuracy/eval/pass-comparison";
import { exportExperimentsForSourceWorkspace, type ExperimentRecord } from "@/accuracy/experiments/records";
import * as comparisonService from "@/accuracy/experiments/pass-comparison";
import * as copyService from "@/accuracy/experiments/copy-workspace";
import { runShallowAgenticCycle } from "@/accuracy/kernel/agentic";
import { activeAccuracyModuleId, activateAccuracyModule, registerAccuracyModule } from "@/accuracy/kernel/registry";
import { agenticModule } from "@/accuracy/modules/_factory";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { createOrganization, createWorkspace, deleteWorkspace, getWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { accuracyDb } from "@/accuracy/store/db";
import { accuracyWorkspaces } from "@/accuracy/store/schema";
import { newId } from "@/modules/kernel/ids";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));

import { GET, POST } from "@/app/api/accuracy/experiments/pass-comparisons/route";
import { POST as postExperiment } from "@/app/api/accuracy/experiments/route";

const session = {
  signed_in: true, session: { subject: "pass-api-subject" },
  actor: { name: "Session actor", function: "medical_affairs" as const }, role: "contributor" as const,
};
const sources: string[] = [];
const fixtureCopies: string[] = [];
let originalModule: string | undefined;

beforeAll(() => registerAccuracyStack());
beforeEach(() => { sessionContext.mockResolvedValue(session); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalModule) activateAccuracyModule({ call_kind: "need_extract", module_id: originalModule, activated_by: "API test restore" });
  originalModule = undefined;
  for (const workspace_id of fixtureCopies.splice(0)) await deleteWorkspace(workspace_id);
  for (const workspace_id of sources.splice(0)) {
    const experiments = JSON.parse(await exportExperimentsForSourceWorkspace({ source_workspace_id: workspace_id, format: "json" })) as ExperimentRecord[];
    for (const experiment of experiments) await deleteWorkspace(experiment.workspace_id);
    await deleteWorkspace(workspace_id);
  }
});

async function fixture() {
  const org_id = await createOrganization(newId("pass-api-org"));
  const workspace_id = await createWorkspace({ org_id, name: "API source", slug: newId("pass-api-source") });
  sources.push(workspace_id);
  await grantOrganizationAccess({ subject: session.session.subject, org_id });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{
    id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Source evidence.",
  }] });
  return { mode: "single_call", source_workspace_id: workspace_id, source_file_ids: [source.id],
    pack_id: "beone-bgb-58067-prmt5i", condition: { label: "API comparison" },
    call: { call_kind: "need_extract", input: { workspace_id, source_file_id: source.id, block_ids: [block_id] } } };
}

function controlled(fail = false) {
  originalModule ??= activeAccuracyModuleId("need_extract");
  const module_id = newId("pass-api-module");
  registerAccuracyModule(agenticModule({ id: module_id, call_kind: "need_extract", title: "API local extraction", summary: "No model calls",
    inputSchema: z.object({ workspace_id: z.string(), source_file_id: z.string(), block_ids: z.array(z.string()).default([]) }),
    outputSchema: z.object({ workspace_id: z.string(), source_file_id: z.string(), gaps: z.array(z.unknown()) }),
    run: async (input, context) => {
      const result = await runShallowAgenticCycle({ run: context.run, maxExchanges: 0, proposer: async () => ({ gaps: [] }),
        onSnapshot: async () => ({ quote_validity: { valid_count: 0, invalid_count: 0, unchecked_count: 0 }, invariant_failures: [], completeness: "not_checked" }),
        critic: async () => { if (fail) throw new Error("Local critic failed"); return { score: 1, issues: [] }; }, judge: async draft => draft });
      return { output: { workspace_id: input.workspace_id, source_file_id: input.source_file_id, ...result.final }, summary: "local extraction" };
    },
  }));
  activateAccuracyModule({ call_kind: "need_extract", module_id, activated_by: "API test" });
}

function post(body: unknown) {
  return POST(new Request("http://localhost/api/accuracy/experiments/pass-comparisons", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

function get(source_workspace_id: string, experiment_ids: string[]) {
  const url = new URL("http://localhost/api/accuracy/experiments/pass-comparisons");
  url.searchParams.set("source_workspace_id", source_workspace_id);
  for (const id of experiment_ids) url.searchParams.append("experiment_id", id);
  return GET(new Request(url));
}

async function records(source_workspace_id: string) {
  return JSON.parse(await exportExperimentsForSourceWorkspace({ source_workspace_id, format: "json" })) as ExperimentRecord[];
}

async function workspaceIds() {
  return (await accuracyDb().select({ id: accuracyWorkspaces.id }).from(accuracyWorkspaces)).map(row => row.id).sort();
}

async function anotherSource(workspace_id: string) {
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) throw new Error("Test source workspace missing");
  const source = await insertSourceFile({ workspace_id, org_id: workspace.org_id, filename: "another.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{
    id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Other source evidence.",
  }] });
  return { source_file_id: source.id, block_id };
}

describe("authenticated controlled pass comparison API", () => {
  it("requires a signed-in session for POST and GET", async () => {
    sessionContext.mockResolvedValue({ ...session, signed_in: false });
    expect((await post({})).status).toBe(401);
    expect((await get("missing", ["missing"])).status).toBe(401);
  });

  it("forbids a reader from executing comparisons", async () => {
    sessionContext.mockResolvedValue({ ...session, role: "viewer" });
    expect((await post({})).status).toBe(403);
  });

  it.each(["comparison_id", "comparison_evaluator_version", "original_request_identity", "original_request_fingerprint", "critic_revision_passes", "experiment_cycle_control"])("rejects client-owned condition control %s before copying", async key => {
    const body = await fixture();
    expect((await post({ ...body, condition: { [key]: key === "critic_revision_passes" ? 2 : "forged" } })).status).toBe(400);
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it.each(["actor", "org_id", "workspace_id", "gold", "comparison_id", "experiment_cycle_control"])("rejects client-owned top-level %s before copying", async key => {
    const body = await fixture();
    expect((await post({ ...body, [key]: "forged" })).status).toBe(400);
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it("rejects malformed JSON as a public validation error", async () => {
    const response = await POST(new Request("http://localhost/api/accuracy/experiments/pass-comparisons", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
  });

  it.each(["exact", "trimmed"])("rejects %s duplicate source IDs before the runner or copy boundary", async normalization => {
    const body = await fixture();
    const source_id = body.source_file_ids[0];
    const before = await workspaceIds();
    const runnerBoundary = vi.spyOn(comparisonService, "runPassComparison");
    const copyBoundary = vi.spyOn(copyService, "copyExperimentWorkspace");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await post({ ...body, source_file_ids: [source_id, normalization === "trimmed" ? ` ${source_id} ` : source_id] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Source file IDs must be distinct." });
    expect(await records(body.source_workspace_id)).toEqual([]);
    expect(await workspaceIds()).toEqual(before);
    expect(runnerBoundary).not.toHaveBeenCalled();
    expect(copyBoundary).not.toHaveBeenCalled();
  });

  it("rejects an unknown pack and a source from another workspace before copying", async () => {
    const body = await fixture(); const other = await fixture();
    const pack = await post({ ...body, pack_id: "missing-pack" });
    expect(pack.status).toBe(400);
    expect(await pack.json()).toEqual({ error: "Unknown reference pack" });
    const source = await post({ ...body, source_file_ids: other.source_file_ids });
    expect(source.status).toBe(400);
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it("uses real organization grants for source scope before run or read", async () => {
    const body = await fixture();
    sessionContext.mockResolvedValue({ ...session, session: { subject: "ungranted" } });
    for (const response of [await post(body), await get(body.source_workspace_id, ["missing"])]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Source workspace not found" });
    }
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it("rejects a controlled non-extraction call before copying", async () => {
    const body = await fixture();
    expect((await post({ ...body, call: { call_kind: "ideate", input: { workspace_id: body.source_workspace_id, gaps: [], existing_tactic_names: [] } } })).status).toBe(400);
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it("rejects invalid pass counts on the existing endpoint before copying", async () => {
    const body = await fixture();
    for (const critic_revision_passes of [0, 4, -1, 1.5, "2", null]) {
      const response = await postExperiment(new Request("http://localhost/api/accuracy/experiments", {
        method: "POST", body: JSON.stringify({ ...body, condition: { critic_revision_passes } }),
      }));
      expect(response.status).toBe(400);
    }
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it("rejects unknown nested module input and copied identifiers before copying", async () => {
    const body = await fixture(); controlled();
    for (const extra of [{ gold: [{ answer: "secret" }] }, { copiedWorkspaceId: "copy" }, { experiment_cycle_control: { critic_revision_passes: 3 } }]) {
      expect((await post({ ...body, call: { ...body.call, input: { ...body.call.input, ...extra } } })).status).toBe(400);
    }
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it.each(["need_extract", "inventory_extract"].flatMap(call_kind =>
    ["foreign", "copied", "missing"].flatMap(origin =>
      ["workspace_id", "source_file_id", "block_ids"].map(field => ({ call_kind, origin, field })))))
  ("rejects $origin $field under real $call_kind input keys before any copy", async ({ call_kind, origin, field }) => {
    const body = await fixture(); controlled();
    let identifiers: { workspace_id: string; source_file_id: string; block_ids: string[] };
    if (origin === "copied") {
      const copy = await copyService.copyExperimentWorkspace({ source_workspace_id: body.source_workspace_id, source_file_ids: body.source_file_ids });
      fixtureCopies.push(copy.workspace_id);
      identifiers = { workspace_id: copy.workspace_id, source_file_id: copy.source_id_map[body.source_file_ids[0]],
        block_ids: [copy.block_id_map[body.call.input.block_ids[0]]] };
    } else if (origin === "foreign") {
      identifiers = (await fixture()).call.input;
    } else {
      identifiers = { workspace_id: "absent-workspace", source_file_id: "absent-source", block_ids: ["absent-block"] };
    }
    const before = await workspaceIds();
    const copyBoundary = vi.spyOn(copyService, "copyExperimentWorkspace");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await post({ ...body, call: { call_kind, input: { ...body.call.input, [field]: identifiers[field as keyof typeof identifiers] } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid single-call source identifiers." });
    expect(await records(body.source_workspace_id)).toEqual([]);
    expect(await workspaceIds()).toEqual(before);
    // Workspace snapshots alone would miss a copy created then deleted on remapping failure.
    expect(copyBoundary).not.toHaveBeenCalled();
  });

  it.each(["need_extract", "inventory_extract"].flatMap(call_kind =>
    ["source_file_id", "block_ids"].map(field => ({ call_kind, field }))))
  ("rejects unselected original $field for $call_kind before copying", async ({ call_kind, field }) => {
    const body = await fixture(); controlled();
    const other = await anotherSource(body.source_workspace_id);
    const before = await workspaceIds();
    const copyBoundary = vi.spyOn(copyService, "copyExperimentWorkspace");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const input = { ...body.call.input, [field]: field === "source_file_id" ? other.source_file_id : [other.block_id] };
    const response = await post({ ...body, call: { call_kind, input } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid single-call source identifiers." });
    expect(await records(body.source_workspace_id)).toEqual([]);
    expect(await workspaceIds()).toEqual(before);
    expect(copyBoundary).not.toHaveBeenCalled();
  });

  it.each(["need_extract", "inventory_extract"])("rejects blocks from another selected source for %s", async call_kind => {
    const body = await fixture(); controlled();
    const other = await anotherSource(body.source_workspace_id);
    const before = await workspaceIds();
    const copyBoundary = vi.spyOn(copyService, "copyExperimentWorkspace");
    const response = await post({ ...body, source_file_ids: [...body.source_file_ids, other.source_file_id],
      call: { call_kind, input: { ...body.call.input, block_ids: [other.block_id] } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid single-call source identifiers." });
    expect(await records(body.source_workspace_id)).toEqual([]);
    expect(await workspaceIds()).toEqual(before);
    expect(copyBoundary).not.toHaveBeenCalled();
  });

  it.each(["need_extract", "inventory_extract"].flatMap(call_kind =>
    ["explicit", "whole_source"].map(selection => ({ call_kind, selection }))))
  ("accepts original $selection block selection for $call_kind", async ({ call_kind, selection }) => {
    const body = await fixture(); controlled();
    const block_ids = selection === "explicit" ? body.call.input.block_ids : [];
    const response = await post({ ...body, call: { call_kind, input: { ...body.call.input, block_ids } } });
    expect(response.status).toBe(201);
    const result = await response.json() as { experiments: ExperimentRecord[] };
    expect(result.experiments).toHaveLength(3);
    for (const experiment of result.experiments) {
      expect(experiment.status).toBe("completed");
      const input = experiment.calls[0].input as Record<string, unknown>;
      expect(input.workspace_id).toBe(experiment.workspace_id);
      expect(input.block_ids).toHaveLength(selection === "explicit" ? 1 : 0);
      if (selection === "explicit") expect(input.block_ids).not.toEqual(block_ids);
    }
  });

  it.each([{ experiment_ids: [] }, { experiment_ids: [""] }, { experiment_ids: ["same", "same"] }, { experiment_ids: ["a", "b", "c", "d"] }])("rejects invalid read ID set $experiment_ids", async ({ experiment_ids }) => {
    expect((await get("source", experiment_ids)).status).toBe(400);
  });

  it("requires one nonempty source workspace query parameter", async () => {
    for (const query of ["experiment_id=a", "source_workspace_id=&experiment_id=a", "source_workspace_id=a&source_workspace_id=b&experiment_id=c"]) {
      expect((await GET(new Request(`http://localhost/api/accuracy/experiments/pass-comparisons?${query}`))).status).toBe(400);
    }
  });

  it("returns independently copied 1/2/3 attempts and permits a granted reader to recompute them", async () => {
    const body = await fixture(); controlled();
    // The real module supplies block_ids=[], proving shared schema normalization survives the API.
    const response = await post({ ...body, call: { ...body.call, input: { workspace_id: body.source_workspace_id, source_file_id: body.source_file_ids[0] } } });
    expect(response.status).toBe(201);
    const result = await response.json() as { comparison_id: string; experiments: ExperimentRecord[]; comparison: PassComparison };
    expect(result.comparison_id).toBeTruthy();
    expect(new Set(result.experiments.map(row => row.workspace_id)).size).toBe(3);
    expect(result.experiments.map(row => (row.condition as Record<string, unknown>).critic_revision_passes)).toEqual([1, 2, 3]);
    expect(result.experiments.map(row => row.calls.map(call => call.version_index))).toEqual([[0, 1], [0, 1, 2], [0, 1, 2, 3]]);
    expect(result.experiments[0].condition).toMatchObject({ original_request_identity: { actor: session.actor } });
    expect(result.experiments[0].calls[0].input).toMatchObject({ workspace_id: result.experiments[0].workspace_id, block_ids: [] });
    sessionContext.mockResolvedValue({ ...session, role: "viewer" });
    const reread = await get(body.source_workspace_id, result.experiments.map(row => row.id));
    expect(reread.status).toBe(200);
    expect(await reread.json()).toEqual({ comparison: result.comparison });
    const partial = await get(body.source_workspace_id, [result.experiments[0].id]);
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({ comparison: { matched: false, recommendation: null, conditions: [{ pass_count: 1 }] } });
    const other = await fixture();
    const foreign = await get(other.source_workspace_id, [result.experiments[0].id]);
    const absent = await get(other.source_workspace_id, ["absent"]);
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await foreign.json()).toEqual(await absent.json());
  });

  it("retains incomplete failed conditions with no recommendation", async () => {
    const body = await fixture(); controlled(true);
    const response = await post(body);
    expect(response.status).toBe(201);
    const result = await response.json() as { experiments: ExperimentRecord[]; comparison: PassComparison };
    expect(result.experiments.map(row => row.status)).toEqual(["failed", "failed", "failed"]);
    expect(result.comparison.recommendation).toBeNull();
    expect(result.comparison.conditions.map(row => row.eligibility)).toEqual(["ineligible", "ineligible", "ineligible"]);
    expect((await get(body.source_workspace_id, result.experiments.map(row => row.id))).status).toBe(200);
  });

  it("accepts the extraction pipeline shape and retains both extractor version sequences", async () => {
    const body = await fixture(); controlled();
    const response = await post({ mode: "pipeline", source_workspace_id: body.source_workspace_id,
      source_file_ids: body.source_file_ids, pack_id: body.pack_id, condition: body.condition });
    expect(response.status).toBe(201);
    const result = await response.json() as { experiments: ExperimentRecord[] };
    expect(result.experiments).toHaveLength(3);
    for (const [index, experiment] of result.experiments.entries()) {
      expect(experiment.status).toBe("completed");
      const expected = [[0, 1], [0, 1, 2], [0, 1, 2, 3]][index];
      expect(experiment.calls.filter(row => row.call_kind === "need_extract").map(row => row.version_index)).toEqual(expected);
      expect(experiment.calls.filter(row => row.call_kind === "inventory_extract").map(row => row.version_index)).toEqual(expected);
    }
  });

  it("maps typed service validation failures to safe public errors", async () => {
    const body = await fixture(); controlled();
    vi.spyOn(comparisonService, "runPassComparison").mockRejectedValue(new comparisonService.PassComparisonValidationError("Internal control detail"));
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid comparison request" });
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it("does not disclose internal execution or storage failures", async () => {
    const body = await fixture(); controlled();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(comparisonService, "runPassComparison").mockRejectedValue(new Error("private storage details"));
    vi.spyOn(comparisonService, "readPassComparison").mockRejectedValue(new Error("private storage details"));
    const start = await post(body);
    const read = await get(body.source_workspace_id, ["attempt"]);
    expect(start.status).toBe(500);
    expect(await start.json()).toEqual({ error: "Could not start pass comparison" });
    expect(read.status).toBe(500);
    expect(await read.json()).toEqual({ error: "Could not read pass comparison" });
    expect(await records(body.source_workspace_id)).toEqual([]);
  });

  it("preserves default single experiment behavior with no client pass count", async () => {
    const body = await fixture(); controlled();
    const response = await postExperiment(new Request("http://localhost/api/accuracy/experiments", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(201);
    const { experiment } = await response.json() as { experiment: ExperimentRecord };
    expect(experiment.condition).not.toHaveProperty("critic_revision_passes");
    expect(experiment.calls.map(row => row.version_index)).toEqual([0]);
  });
});
