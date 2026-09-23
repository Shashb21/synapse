import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST as hygienePost } from "@/app/api/accuracy/hygiene/route";
import { GET as workspacesGet } from "@/app/api/accuracy/workspaces/route";
import { GET as runsGet } from "@/app/api/accuracy/runs/route";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import {
  archiveWorkspace,
  createOrganization,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
} from "@/accuracy/store/tenant";
import { insertClaim, listClaims } from "@/accuracy/store/claim-store";
import { listAccuracyRuns, sweepStaleAccuracyRuns, summarizeAccuracyRunCost } from "@/accuracy";
import { newId } from "@/modules/kernel/ids";

async function freshWorkspace(label: string) {
  await ensureAccuracySchema();
  const org_id = await createOrganization(`org-${label}-${Date.now()}`);
  const workspace_id = await createWorkspace({
    org_id,
    name: `WS ${label}`,
    slug: `${label}-${Date.now()}`,
  });
  return { org_id, workspace_id };
}

async function insertRun(args: {
  org_id: string;
  workspace_id: string;
  call_kind?: string;
  status?: string;
  started_at: string;
  cost_usd?: string | null;
  token_usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}) {
  const id = newId("arun");
  await accuracyDb()
    .insert(t.accuracyModuleRuns)
    .values({
      id,
      org_id: args.org_id,
      workspace_id: args.workspace_id,
      call_kind: args.call_kind ?? "need_extract",
      agent_role: "proposer",
      module_id: "hygiene.test",
      module_version: "0",
      status: args.status ?? "running",
      started_at: args.started_at,
      finished_at: null,
      duration_ms: null,
      actor_name: "hygiene-test",
      actor_function: "medical_affairs",
      summary: null,
      error: null,
      input: { fixture: true },
      output: null,
      steps: [],
      route: null,
      token_usage: args.token_usage ?? null,
      cost_usd: args.cost_usd ?? null,
      evals: null,
    });
  return id;
}

async function postHygiene(body: Record<string, unknown>) {
  return hygienePost(
    new Request("http://localhost/api/accuracy/hygiene", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("workspace hygiene", () => {
  it("archives a workspace so default lists hide it", async () => {
    const { workspace_id } = await freshWorkspace("archive");
    const archived = await archiveWorkspace(workspace_id);
    expect(archived.archived_at).toBeTruthy();

    const active = await listWorkspaces(50);
    expect(active.some((row) => row.id === workspace_id)).toBe(false);

    const withArchived = await listWorkspaces(50, { includeArchived: true });
    expect(withArchived.some((row) => row.id === workspace_id)).toBe(true);
  });

  it("deletes workspace rows and the empty org", async () => {
    const { org_id, workspace_id } = await freshWorkspace("delete");
    await insertClaim({
      workspace_id,
      claim_type: "gap",
      statement: "Need OS evidence",
      status: "open",
    });
    const result = await deleteWorkspace(workspace_id);
    expect(result.org_deleted).toBe(true);
    expect(result.deleted.claims).toBe(1);
    expect(result.deleted.workspace).toBe(1);
    expect(await getWorkspace(workspace_id)).toBeNull();
    expect(await listClaims(workspace_id)).toEqual([]);

    const orgRows = await accuracyDb()
      .select()
      .from(t.accuracyOrganizations)
      .where(eq(t.accuracyOrganizations.id, org_id));
    expect(orgRows).toEqual([]);
  });

  it("keeps an org that still has another workspace", async () => {
    const { org_id, workspace_id } = await freshWorkspace("keep-org");
    const sibling = await createWorkspace({
      org_id,
      name: "Sibling",
      slug: `sibling-${Date.now()}`,
    });
    const result = await deleteWorkspace(workspace_id);
    expect(result.org_deleted).toBe(false);
    expect(await getWorkspace(sibling)).not.toBeNull();
  });
});

describe("stale-run sweep", () => {
  it("marks old running rows abandoned and leaves fresh running rows", async () => {
    const { org_id, workspace_id } = await freshWorkspace("stale");
    const oldId = await insertRun({
      org_id,
      workspace_id,
      started_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    });
    const freshId = await insertRun({
      org_id,
      workspace_id,
      started_at: new Date().toISOString(),
    });

    const swept = await sweepStaleAccuracyRuns({
      workspace_id,
      maxAgeMs: 30 * 60 * 1000,
    });
    expect(swept.abandoned_ids).toContain(oldId);
    expect(swept.abandoned_ids).not.toContain(freshId);

    const listed = await listAccuracyRuns(workspace_id, 10);
    expect(listed.find((row) => row.id === oldId)?.status).toBe("abandoned");
    expect(listed.find((row) => row.id === freshId)?.status).toBe("running");
  });

  it("rolls up recorded cost after listing", async () => {
    const { org_id, workspace_id } = await freshWorkspace("cost");
    await insertRun({
      org_id,
      workspace_id,
      call_kind: "need_extract",
      status: "ok",
      started_at: new Date().toISOString(),
      cost_usd: "0.10",
      token_usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
    });
    await insertRun({
      org_id,
      workspace_id,
      call_kind: "coverage_decide",
      status: "ok",
      started_at: new Date().toISOString(),
      cost_usd: "0.05",
      token_usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    });
    const rollup = await summarizeAccuracyRunCost(workspace_id);
    expect(rollup.run_count).toBe(2);
    expect(rollup.cost_usd).toBeCloseTo(0.15, 6);
    expect(rollup.total_tokens).toBe(300);
    expect(rollup.by_call_kind).toHaveLength(2);
  });
});

describe("hygiene API", () => {
  it("archives via POST then hides from default workspace GET", async () => {
    const { workspace_id } = await freshWorkspace("api-archive");
    const res = await postHygiene({ action: "archive_workspace", workspace_id });
    expect(res.status).toBe(200);
    const hidden = await workspacesGet(new Request("http://localhost/api/accuracy/workspaces"));
    const hiddenBody = (await hidden.json()) as { workspaces: { id: string }[] };
    expect(hiddenBody.workspaces.some((row) => row.id === workspace_id)).toBe(false);

    const shown = await workspacesGet(
      new Request("http://localhost/api/accuracy/workspaces?include_archived=1"),
    );
    const shownBody = (await shown.json()) as { workspaces: { id: string }[] };
    expect(shownBody.workspaces.some((row) => row.id === workspace_id)).toBe(true);
  });

  it("sweeps stale runs and returns a cost rollup on GET /runs", async () => {
    const { org_id, workspace_id } = await freshWorkspace("api-runs");
    await insertRun({
      org_id,
      workspace_id,
      started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const sweep = await postHygiene({
      action: "sweep_stale_runs",
      workspace_id,
      max_age_ms: 60_000,
    });
    const sweepBody = (await sweep.json()) as { ok?: boolean; abandoned_ids?: string[] };
    expect(sweepBody.ok).toBe(true);
    expect(sweepBody.abandoned_ids?.length).toBeGreaterThan(0);

    const runsRes = await runsGet(
      new Request(`http://localhost/api/accuracy/runs?workspace_id=${encodeURIComponent(workspace_id)}`),
    );
    const runsBody = (await runsRes.json()) as {
      runs: { status: string }[];
      rollup: { run_count: number };
    };
    expect(runsBody.rollup.run_count).toBeGreaterThan(0);
    expect(runsBody.runs.some((row) => row.status === "abandoned")).toBe(true);
  });

  it("rejects unknown workspaces", async () => {
    const res = await postHygiene({ action: "delete_workspace", workspace_id: "ws-missing" });
    expect(res.status).toBe(404);
  });
});
