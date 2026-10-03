import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { GET } from "@/app/api/accuracy/assemblies/route";
import { createAssembly } from "@/accuracy/store/assembly-store";
import { publishGeneratedItemHistory } from "@/accuracy/store/item-history-store";
import { accuracyDb, ensureAccuracySchema } from "@/accuracy/store/db";
import * as t from "@/accuracy/store/schema";
import { createOrganization, createWorkspace, deleteWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";
import { newId, nowIso } from "@/modules/kernel/ids";

const { sessionContext } = vi.hoisted(() => ({ sessionContext: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext }));

const actor = { name: "Assembly reader", function: "medical_affairs" as const };
const session = { signed_in: true, demo: false, role: "viewer" as const, actor,
  session: { subject: "assembly-reader" } };
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspace_id of workspaces.splice(0)) await deleteWorkspace(workspace_id);
});

async function fixture() {
  await ensureAccuracySchema();
  sessionContext.mockResolvedValue(session);
  const org_id = await createOrganization(newId("assembly-api-org"));
  const workspace_id = await createWorkspace({ org_id, name: "Assembly API", slug: newId("assembly-api") });
  workspaces.push(workspace_id);
  await grantOrganizationAccess({ subject: session.session.subject, org_id });
  const source = await insertSourceFile({ workspace_id, org_id, filename: "source.txt", mime: "text/plain", checksum: newId("sum") });
  const block_id = newId("block");
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test",
    blocks: [{ id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: "Supported source text." }] });
  const gap = { id: "gap-api", statement: "API gap", external_id: null,
    provenance: [{ source_file_id: source.id, block_id, quote: "Supported source" }] };
  const run_id = newId("arun");
  const now = nowIso();
  await accuracyDb().insert(t.accuracyModuleRuns).values({ id: run_id, org_id, workspace_id, call_kind: "need_extract",
    agent_role: "proposer", module_id: "test", module_version: "1", status: "ok", started_at: now, finished_at: now,
    actor_name: actor.name, actor_function: actor.function,
    input: { workspace_id, source_file_id: source.id }, output: { workspace_id, source_file_id: source.id, gaps: [gap] }, steps: [] });
  await publishGeneratedItemHistory({ workspace_id, source_file_id: source.id, run_id, claim_type: "gap",
    final_claims: [{ id: gap.id, workspace_id, source_file_id: source.id, claim_type: "gap", statement: gap.statement }] });
  const [version] = await accuracyDb().select().from(t.accuracyItemVersions).where(eq(t.accuracyItemVersions.workspace_id, workspace_id));
  const assembly = await createAssembly({ workspace_id, actor, source_file_ids: [source.id],
    selections: [{ item_version_id: version!.id, reason: "readable" }], mappings: [], coverage_run_ids: [], linking_complete: true });
  return { org_id, workspace_id, assembly };
}

function get(query: string) {
  return GET(new Request(`http://localhost/api/accuracy/assemblies?${query}`));
}

describe("authorized assembly API", () => {
  it("requires a signed-in authorized workspace and supports strict list/read queries", async () => {
    const scope = await fixture();
    const list = await get(`workspace_id=${scope.workspace_id}`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ assemblies: [scope.assembly] });

    const read = await get(`workspace_id=${scope.workspace_id}&assembly_id=${scope.assembly.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      assembly: scope.assembly,
      can_review: false,
      review_state: { assembly_id: scope.assembly.id, status: "stale", expected_review_id: null, latest_decision: null },
    });

    sessionContext.mockResolvedValue({ ...session, signed_in: false, session: null });
    expect((await get(`workspace_id=${scope.workspace_id}`)).status).toBe(401);

    sessionContext.mockResolvedValue({ ...session, session: { subject: "foreign" } });
    expect((await get(`workspace_id=${scope.workspace_id}`)).status).toBe(404);
    expect((await get(`workspace_id=${scope.workspace_id}&assembly_id=missing`)).status).toBe(404);
  });

  it.each(["", "workspace_id=", "workspace_id=w&workspace_id=w", "workspace_id=w&assembly_id=", "workspace_id=w&assembly_id=a&assembly_id=a", "workspace_id=w&extra=1"])
  ("rejects malformed or extra query parameters: %s", async query => {
    sessionContext.mockResolvedValue(session);
    expect((await get(query)).status).toBe(400);
  });

  it("logs runtime faults and returns a generic 500", async () => {
    const scope = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(await import("@/accuracy/store/assembly-store"), "listAssemblies").mockRejectedValue(new Error("private database detail"));
    const response = await get(`workspace_id=${scope.workspace_id}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not read assemblies" });
    expect(log).toHaveBeenCalledOnce();
  });
});
