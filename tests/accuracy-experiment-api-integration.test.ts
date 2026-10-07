import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createWorkspace } from "@/app/api/accuracy/workspaces/route";
import { POST as startExperiment } from "@/app/api/accuracy/experiments/route";
import { registerAccuracyStack } from "@/accuracy";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { deleteWorkspace } from "@/accuracy/store/tenant";
import * as tables from "@/accuracy/store/schema";
import { eq } from "drizzle-orm";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));

const createdWorkspaces: string[] = [];
const creator = {
  signed_in: true,
  session: { subject: "creator-subject" },
  actor: { name: "Experiment creator", function: "medical_affairs" as const },
  role: "contributor" as const,
};

beforeEach(() => {
  registerAccuracyStack();
  sessionContext.mockResolvedValue(creator);
});

afterEach(async () => {
  for (const workspace_id of createdWorkspaces.splice(0)) {
    await deleteWorkspace(workspace_id);
  }
});

describe("experiment API integration", () => {
  it("grants the authenticated workspace creator and remaps a valid source workspace input into the isolated copy", async () => {
    await ensureAccuracySchema();
    const workspaceResponse = await createWorkspace(new Request("http://localhost/api/accuracy/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Experiment source", slug: `experiment-source-${Date.now()}` }),
    }));
    expect(workspaceResponse.status).toBe(200);
    const { org_id, workspace_id } = await workspaceResponse.json() as { org_id: string; workspace_id: string };
    createdWorkspaces.push(workspace_id);

    const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: `sum-${Date.now()}` });
    const block_id = `${source.id}-block`;
    await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Need survival evidence." }] });

    const response = await startExperiment(new Request("http://localhost/api/accuracy/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "single_call",
        source_workspace_id: workspace_id,
        source_file_ids: [source.id],
        pack_id: "beone-bgb-58067-prmt5i",
        condition: { temperature: 0 },
        call: {
          call_kind: "need_extract",
          input: { workspace_id, source_file_id: source.id, block_ids: [block_id] },
        },
      }),
    }));

    expect(response.status).toBe(201);
    const { experiment } = await response.json() as { experiment: { id: string; workspace_id: string; calls: Array<{ input: Record<string, unknown> }> } };
    createdWorkspaces.push(experiment.workspace_id);
    expect(experiment.calls[0]?.input.workspace_id).toBe(experiment.workspace_id);
    expect(experiment.calls[0]?.input.workspace_id).not.toBe(workspace_id);
    const persisted = await accuracyDb().select().from(tables.accuracyExperimentCalls).where(eq(tables.accuracyExperimentCalls.experiment_id, experiment.id));
    expect(persisted[0]?.input).toMatchObject({ workspace_id: experiment.workspace_id });

    // Legacy callers may supply a previous copied workspace ID; the existing endpoint still remaps it.
    const legacy = await startExperiment(new Request("http://localhost/api/accuracy/experiments", {
      method: "POST", body: JSON.stringify({ mode: "single_call", source_workspace_id: workspace_id,
        source_file_ids: [source.id], pack_id: "beone-bgb-58067-prmt5i", condition: {},
        call: { call_kind: "need_extract", input: { workspace_id: experiment.workspace_id, source_file_id: source.id, block_ids: [block_id] } } }),
    }));
    expect(legacy.status).toBe(201);
    const { experiment: legacyExperiment } = await legacy.json() as { experiment: typeof experiment };
    createdWorkspaces.push(legacyExperiment.workspace_id);
    expect(legacyExperiment.workspace_id).not.toBe(experiment.workspace_id);
    expect(legacyExperiment.calls[0]?.input.workspace_id).toBe(legacyExperiment.workspace_id);
  });
});
