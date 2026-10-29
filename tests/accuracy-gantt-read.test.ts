import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import type { AccuracyPlanRecord } from "@/accuracy/store/plan-store";

const stores = vi.hoisted(() => ({
  claims: vi.fn(), joins: vi.fn(), latest: vi.fn(), owner: vi.fn(), pageOwner: vi.fn(),
}));
vi.mock("@/accuracy", () => ({ registerAccuracyStack: vi.fn() }));
vi.mock("@/modules/auth/owner", () => ({ ownerGate: stores.owner, requireOwnerPage: stores.pageOwner }));
vi.mock("@/accuracy/store/claim-store", async (original) => ({
  ...await original<typeof import("@/accuracy/store/claim-store")>(), listClaims: stores.claims,
}));
vi.mock("@/accuracy/store/coverage-store", () => ({ listCoverageJoins: stores.joins }));
vi.mock("@/accuracy/store/plan-store", () => ({ latestAccuracyPlan: stores.latest }));
vi.mock("@/accuracy/store/tenant", () => ({
  listWorkspaces: async () => [], getWorkspace: async () => ({ id: "ws", name: "Workspace" }),
}));
import { GET } from "@/app/api/accuracy/gantt/route";
import TimelinePage from "@/app/admin/accuracy/timeline/page";
import { AccuracyGanttBoard } from "@/components/accuracy/accuracy-gantt-board";
import { snapshotHashForPlan } from "@/accuracy/modules/gantt-project/save-final";

const activity = { id: "ACT-T1", tactic_id: "T1", start: "2026-01-01", end: "2026-06-01", readout: null, depends_on: [], gap_ids: [] };
function savedPlan(): AccuracyPlanRecord {
  return { id: "plan-1", workspace_id: "ws", version: 1, status: "final", note: "Reviewed", saved_by: "Owner", saved_function: "medical_affairs", saved_at: "2026-01-01", snapshot: { activities: [activity], tactic_ids: ["T1"], counts: { activities: 1, validated_tactics: 1 }, labels: [{ id: "T1", claim_type: "tactic", statement: "Frozen study" }], snapshot_hash: "frozen-hash" } };
}
function treeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join(" ");
  return isValidElement<{ children?: ReactNode }>(node) ? treeText(node.props.children) : "";
}
function boardProps(node: ReactNode): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map(boardProps).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return;
  if (node.type === AccuracyGanttBoard) return node.props;
  return boardProps(node.props.children);
}
const read = () => GET(new Request("http://localhost/api/accuracy/gantt?workspace_id=ws"));
beforeEach(() => {
  vi.resetAllMocks();
  stores.owner.mockResolvedValue(null);
  stores.latest.mockResolvedValue(savedPlan());
  stores.joins.mockResolvedValue([]);
  stores.claims.mockResolvedValue([{ id: "T1", workspace_id: "ws", claim_type: "tactic", statement: "Live renamed study", validated: true, status: "validated", metadata: { start: "2027-01-01", end: "2027-06-01" } }]);
});

describe("frozen Gantt read semantics", () => {
  it("GET and page pair frozen activities and labels with the saved hash while exposing live separately", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.activities).toEqual([activity]);
    expect(json.catalog).toEqual(savedPlan().snapshot.labels);
    expect(json.snapshot_hash).toBe("frozen-hash");
    expect(json.live.activities[0].start).toBe("2027-01-01");
    expect(json.live.catalog[0].statement).toBe("Live renamed study");
    const props = boardProps(await TimelinePage({ searchParams: Promise.resolve({ workspace_id: "ws" }) }));
    expect(props?.activities).toEqual(json.activities);
    expect(props?.catalog).toEqual(json.catalog);
    expect(props?.snapshotHash).toBe(json.snapshot_hash);
    expect(props?.liveActivities).toEqual(json.live.activities);
    expect(props?.liveCatalog).toEqual(json.live.catalog);
  });
  it("uses frozen bars and ID fallback for legacy plans without labels or a stored hash", async () => {
    const plan = savedPlan();
    delete plan.snapshot.labels;
    delete plan.snapshot.snapshot_hash;
    stores.latest.mockResolvedValue(plan);
    const json = await (await read()).json();
    expect(json.activities).toEqual([activity]);
    expect(json.catalog).toEqual([]);
    expect(json.snapshot_hash).toBe(snapshotHashForPlan(plan));
    expect(json.audit_bundle.snapshot_hash).toBe(json.snapshot_hash);
  });
  it("returns the live projection without saved metadata when no plan exists", async () => {
    stores.latest.mockResolvedValue(null);
    const json = await (await read()).json();
    expect(json.activities[0].start).toBe("2027-01-01");
    expect(json.catalog[0].statement).toBe("Live renamed study");
    expect(json.plan).toBeNull();
    expect(json.snapshot_hash).toBeNull();
    expect(json.audit_bundle).toBeNull();
  });
  it("keeps a frozen chart readable when live tactics have been removed", async () => {
    stores.claims.mockResolvedValue([]);
    const json = await (await read()).json();
    expect(json.activities).toEqual([activity]);
    expect(json.live.activities).toEqual([]);
    expect(json.validated_tactic_count).toBe(1);
  });
  it("preserves owner denial and required workspace handling", async () => {
    stores.owner.mockResolvedValue(new Response("Denied", { status: 403 }));
    expect((await read()).status).toBe(403);
    expect(stores.latest).not.toHaveBeenCalled();
    stores.owner.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/api/accuracy/gantt"))).status).toBe(400);
  });
  it("reports loading failures through the existing API and page error surfaces", async () => {
    stores.claims.mockRejectedValue(new Error("Projection unavailable"));
    const response = await read();
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ safe_error: true, error: expect.stringContaining("Check the current state") });
    expect(body.error).not.toContain("Projection unavailable");
    const tree = await TimelinePage({ searchParams: Promise.resolve({ workspace_id: "ws" }) });
    expect(treeText(tree)).toContain("Could not load timeline. Reload this page to try again.");
    expect(treeText(tree)).not.toContain("Projection unavailable");
  });
});
