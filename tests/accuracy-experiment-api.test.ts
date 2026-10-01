import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sessionContext,
  runAccuracyExperiment,
  getWorkspace,
  getAuthorizedWorkspace,
  getSourceFile,
  getExperimentForSourceWorkspace,
  exportExperimentsForSourceWorkspace,
  mustFindForPack,
} = vi.hoisted(() => ({
  sessionContext: vi.fn(),
  runAccuracyExperiment: vi.fn(),
  getWorkspace: vi.fn(),
  getAuthorizedWorkspace: vi.fn(),
  getSourceFile: vi.fn(),
  getExperimentForSourceWorkspace: vi.fn(),
  exportExperimentsForSourceWorkspace: vi.fn(),
  mustFindForPack: vi.fn(),
}));

vi.mock("@/modules/auth/session", () => ({ sessionContext }));
vi.mock("@/accuracy/experiments/run", () => ({ runAccuracyExperiment }));
vi.mock("@/accuracy/store/tenant", () => ({ getAuthorizedWorkspace, getWorkspace }));
vi.mock("@/accuracy/store/source-store", () => ({ getSourceFile }));
vi.mock("@/accuracy/experiments/records", () => ({
  getExperimentForSourceWorkspace,
  exportExperimentsForSourceWorkspace,
}));
vi.mock("@/accuracy/eval/reference-gold", () => ({ mustFindForPack }));
vi.mock("@/accuracy", () => ({ registerAccuracyStack: vi.fn() }));

import { GET as getExperiments, POST as postExperiment } from "@/app/api/accuracy/experiments/route";
import { GET as getExperiment } from "@/app/api/accuracy/experiments/[experiment_id]/route";

const signedInContributor = {
  signed_in: true,
  session: { subject: "subject-source" },
  actor: { name: "A contributor", function: "medical_affairs" },
  role: "contributor",
};

function post(body: Record<string, unknown>) {
  return postExperiment(new Request("http://localhost/api/accuracy/experiments", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

function sourceWorkspaceRequest(path = "http://localhost/api/accuracy/experiments?source_workspace_id=ws-source") {
  return new Request(path);
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionContext.mockResolvedValue(signedInContributor);
  getWorkspace.mockResolvedValue({ id: "ws-source", org_id: "org-source" });
  getAuthorizedWorkspace.mockResolvedValue({ id: "ws-source", org_id: "org-source" });
  getSourceFile.mockResolvedValue({ id: "src-source", workspace_id: "ws-source" });
  mustFindForPack.mockReturnValue({ id: "beone-bgb-58067-prmt5i" });
});

describe("accuracy experiment API", () => {
  it("rejects an unauthenticated attempt before starting an experiment", async () => {
    sessionContext.mockResolvedValue({ ...signedInContributor, signed_in: false });
    const response = await post({ mode: "pipeline", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i", condition: {} });
    expect(response.status).toBe(401);
    expect(runAccuracyExperiment).not.toHaveBeenCalled();
  });

  it("rejects a signed-in reader without validation capability", async () => {
    sessionContext.mockResolvedValue({ ...signedInContributor, role: "viewer" });
    const response = await post({ mode: "pipeline", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i", condition: {} });
    expect(response.status).toBe(403);
  });

  it("denies a signed-in user without a grant before a run, read, or export", async () => {
    getAuthorizedWorkspace.mockResolvedValue(null);
    const start = await post({ mode: "pipeline", source_workspace_id: "ws-other", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i", condition: {} });
    expect(start.status).toBe(404);
    expect(runAccuracyExperiment).not.toHaveBeenCalled();

    const read = await getExperiment(sourceWorkspaceRequest("http://localhost/api/accuracy/experiments/experiment-1?source_workspace_id=ws-other"), { params: Promise.resolve({ experiment_id: "experiment-1" }) });
    expect(read.status).toBe(404);
    expect(getExperimentForSourceWorkspace).not.toHaveBeenCalled();

    const exported = await getExperiments(sourceWorkspaceRequest("http://localhost/api/accuracy/experiments?source_workspace_id=ws-other"));
    expect(exported.status).toBe(404);
    expect(exportExperimentsForSourceWorkspace).not.toHaveBeenCalled();
  });

  it("rejects an unknown pack and a source outside the supplied source workspace", async () => {
    mustFindForPack.mockImplementation(() => { throw new Error("Unknown reference pack"); });
    const invalidPack = await post({ mode: "pipeline", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "unknown", condition: {} });
    expect(invalidPack.status).toBe(400);

    mustFindForPack.mockReturnValue({ id: "beone-bgb-58067-prmt5i" });
    getSourceFile.mockResolvedValue(null);
    const crossedSource = await post({ mode: "pipeline", source_workspace_id: "ws-source", source_file_ids: ["src-other"], pack_id: "beone-bgb-58067-prmt5i", condition: {} });
    expect(crossedSource.status).toBe(400);
    expect(runAccuracyExperiment).not.toHaveBeenCalled();
  });

  it("runs a validated experiment with actor identity derived from the server session", async () => {
    runAccuracyExperiment.mockResolvedValue({ id: "experiment-1", workspace_id: "ws-copy", source_workspace_id: "ws-source", calls: [], evaluations: [] });
    const response = await post({
      mode: "single_call", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i",
      condition: { temperature: 0 }, call: { call_kind: "need_extract", input: { source_file_id: "src-source" } },
      actor: { name: "Client supplied", function: "viewer" }, workspace_id: "ws-copy", gold: [{ answer: "secret" }],
    });
    expect(response.status).toBe(400);

    const accepted = await post({
      mode: "single_call", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i",
      condition: { temperature: 0 }, call: { call_kind: "need_extract", input: { source_file_id: "src-source" } },
    });
    expect(accepted.status).toBe(201);
    expect(runAccuracyExperiment).toHaveBeenCalledWith(expect.objectContaining({
      actor: signedInContributor.actor, source_workspace_id: "ws-source",
    }));
    expect((await accepted.json()).experiment.id).toBe("experiment-1");
  });

  it("rejects gold and copied-workspace values at every nested request level", async () => {
    for (const body of [
      { mode: "pipeline", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i", condition: { nested: { gold: [{ answer: "secret" }] } } },
      { mode: "single_call", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i", condition: {}, call: { call_kind: "need_extract", input: { nested: { copied_workspace_id: "ws-copy" } } } },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(runAccuracyExperiment).not.toHaveBeenCalled();
  });

  it("does not expose unexpected runner failures as invalid request errors", async () => {
    runAccuracyExperiment.mockRejectedValue(new Error("database password leaked"));
    const response = await post({ mode: "pipeline", source_workspace_id: "ws-source", source_file_ids: ["src-source"], pack_id: "beone-bgb-58067-prmt5i", condition: {} });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not start experiment" });
  });

  it("reads a single experiment only through its source workspace", async () => {
    getExperimentForSourceWorkspace.mockResolvedValue({ id: "experiment-1", source_workspace_id: "ws-source", calls: [], evaluations: [] });
    const response = await getExperiment(sourceWorkspaceRequest("http://localhost/api/accuracy/experiments/experiment-1?source_workspace_id=ws-source"), { params: Promise.resolve({ experiment_id: "experiment-1" }) });
    expect(response.status).toBe(200);
    expect(getExperimentForSourceWorkspace).toHaveBeenCalledWith({ source_workspace_id: "ws-source", experiment_id: "experiment-1" });

    getExperimentForSourceWorkspace.mockResolvedValue(null);
    const crossed = await getExperiment(sourceWorkspaceRequest("http://localhost/api/accuracy/experiments/experiment-1?source_workspace_id=ws-other"), { params: Promise.resolve({ experiment_id: "experiment-1" }) });
    expect(crossed.status).toBe(404);
  });

  it("exports all source-scoped records as deterministic JSON and one JSONL record per line", async () => {
    exportExperimentsForSourceWorkspace.mockResolvedValue(JSON.stringify({ id: "first" }) + "\n" + JSON.stringify({ id: "second" }) + "\n");
    const jsonl = await getExperiments(sourceWorkspaceRequest("http://localhost/api/accuracy/experiments?source_workspace_id=ws-source&format=jsonl"));
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get("content-type")).toContain("application/x-ndjson");
    expect((await jsonl.text()).trim().split("\n")).toHaveLength(2);

    exportExperimentsForSourceWorkspace.mockResolvedValue(JSON.stringify([{ id: "first" }, { id: "second" }]));
    const json = await getExperiments(sourceWorkspaceRequest());
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual([{ id: "first" }, { id: "second" }]);
    expect(exportExperimentsForSourceWorkspace).toHaveBeenLastCalledWith({ source_workspace_id: "ws-source", format: "json" });
  });
});
