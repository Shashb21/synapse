/** Authenticated result export boundary tests. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrganization, createWorkspace, deleteWorkspace, getAuthorizedWorkspace, grantOrganizationAccess } from "@/accuracy/store/tenant";
import { createExperiment } from "@/accuracy/experiments/records";
import { newId } from "@/modules/kernel/ids";

const mocks = vi.hoisted(() => ({ sessionContext: vi.fn(), authorizedSourceWorkspace: vi.fn(), readExperimentResults: vi.fn() }));
vi.mock("@/accuracy", () => ({ registerAccuracyStack: vi.fn() }));
vi.mock("@/modules/auth/session", () => ({ sessionContext: mocks.sessionContext }));
vi.mock("@/app/api/accuracy/experiments/request", () => ({ authorizedSourceWorkspace: mocks.authorizedSourceWorkspace }));
vi.mock("@/accuracy/experiments/results", () => ({ readExperimentResults: mocks.readExperimentResults }));
import { GET } from "@/app/api/accuracy/experiments/results/route";

const url = "http://localhost/api/accuracy/experiments/results";
const session = { signed_in: true, session: { subject: "owner" }, role: "viewer" };
const report = { schema_version: "experiment-results-v1", source_workspace_id: "source", entries: [
  { id: "experiment:one", kind: "standalone_attempt", evidence: { experiments: [{ id: "one", calls: [{ input: { raw: true } }] }] } },
], repeat_series: [] };
function get(query = "source_workspace_id=source") { return GET(new Request(`${url}?${query}`)); }

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.sessionContext.mockResolvedValue(session);
  mocks.authorizedSourceWorkspace.mockImplementation(async id => id === "source" ? { id } : null);
  mocks.readExperimentResults.mockResolvedValue(report);
});

describe("experiment results API", () => {
  it("authenticates before querying or reading history", async () => {
    mocks.sessionContext.mockResolvedValue({ ...session, signed_in: false });
    expect((await get("bad=query")).status).toBe(401);
    expect(mocks.authorizedSourceWorkspace).not.toHaveBeenCalled();
    expect(mocks.readExperimentResults).not.toHaveBeenCalled();
  });

  it.each(["source_workspace_id=foreign", "source_workspace_id=missing"])("hides inaccessible source %s", async query => {
    expect((await get(query)).status).toBe(404);
    expect(mocks.readExperimentResults).not.toHaveBeenCalled();
  });

  it.each(["", "source_workspace_id=", "source_workspace_id=%20", "format=json", "source_workspace_id=source&format=csv",
    "source_workspace_id=source&format=json&format=json", "source_workspace_id=source&source_workspace_id=source",
    "source_workspace_id=source&unexpected=1"])("rejects invalid query %s", async query => {
    expect((await get(query)).status).toBe(400);
    expect(mocks.readExperimentResults).not.toHaveBeenCalled();
  });

  it("returns the complete private JSON report and one complete entry per JSONL line", async () => {
    const json = await get();
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual(report);
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(json.headers.get("cache-control")).toBe("private, no-store");
    const jsonl = await get("source_workspace_id=source&format=jsonl");
    expect(jsonl.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await jsonl.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ schema_version: report.schema_version, source_workspace_id: "source", entry: report.entries[0] });
  });

  it("logs an unexpected fault but does not disclose its text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.readExperimentResults.mockRejectedValue(new Error("private database detail"));
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database detail");
    vi.restoreAllMocks();
  });

  it("uses actual organization grants and original-source history before returning evidence", async () => {
    const ownerOrg = await createOrganization(newId("results-api-owner"));
    const foreignOrg = await createOrganization(newId("results-api-foreign"));
    const ownerSource = await createWorkspace({ org_id: ownerOrg, name: "Owner source", slug: newId("results-api-source") });
    const ownerCopy = await createWorkspace({ org_id: ownerOrg, name: "Owner copy", slug: newId("results-api-copy") });
    const foreignSource = await createWorkspace({ org_id: foreignOrg, name: "Foreign source", slug: newId("results-api-foreign-source") });
    const foreignCopy = await createWorkspace({ org_id: foreignOrg, name: "Foreign copy", slug: newId("results-api-foreign-copy") });
    try {
      await grantOrganizationAccess({ subject: session.session.subject, org_id: ownerOrg });
      const ownerAttempt = await createExperiment({ workspace_id: ownerCopy, org_id: ownerOrg, source_workspace_id: ownerSource,
        pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "owner-source", baseline_fingerprint: "owner-baseline",
        baseline_snapshot: { retained: "owner" }, condition: { label: "owner" } });
      const foreignAttempt = await createExperiment({ workspace_id: foreignCopy, org_id: foreignOrg, source_workspace_id: foreignSource,
        pack_id: "beone-bgb-58067-prmt5i", source_fingerprint: "foreign-source", baseline_fingerprint: "foreign-baseline",
        baseline_snapshot: { retained: "foreign" }, condition: { label: "foreign" } });
      const actual = await vi.importActual<typeof import("@/accuracy/experiments/results")>("@/accuracy/experiments/results");
      mocks.authorizedSourceWorkspace.mockImplementation(async id => getAuthorizedWorkspace({ workspace_id: id, subject: session.session.subject, role: "viewer" }));
      mocks.readExperimentResults.mockImplementation(actual.readExperimentResults);

      const allowed = await get(`source_workspace_id=${ownerSource}`);
      expect(allowed.status).toBe(200);
      const loaded = await allowed.json();
      expect(loaded.entries[0].evidence.experiments[0]).toMatchObject({ id: ownerAttempt.id, baseline_snapshot: { retained: "owner" } });
      expect(JSON.stringify(loaded)).not.toContain(foreignAttempt.id);
      const jsonl = await get(`source_workspace_id=${ownerSource}&format=jsonl`);
      expect(jsonl.status).toBe(200);
      expect(JSON.parse((await jsonl.text()).trim()).entry.evidence.experiments[0].baseline_snapshot)
        .toEqual({ retained: "owner" });
      expect((await get(`source_workspace_id=${foreignSource}`)).status).toBe(404);
      expect(mocks.readExperimentResults).toHaveBeenCalledTimes(2);
    } finally {
      for (const id of [ownerCopy, foreignCopy, ownerSource, foreignSource]) await deleteWorkspace(id);
    }
  });
});
