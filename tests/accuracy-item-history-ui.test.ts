/** @vitest-environment jsdom */
/** Exercise ledger history reads and scoped decisions through real React DOM interactions. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HumanItemOrigin } from "@/accuracy/domain/item-history";
import { ClaimHistory } from "@/components/accuracy/claim-history";
import { LedgerClaimCard } from "@/components/accuracy/ledger-claim-card";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
let host: HTMLDivElement;
let root: Root;
const relationship = { id: "proposal", kind: "same_item", predecessor_ids: ["old"], successor_ids: ["new"], rationale: "Shared source", decision: null, stale: false };
const history = { canonical_claim_id: "canonical", claim: {}, versions: [{ id: "version", claim_id: "original", run_id: "run", snapshot_id: "snapshot", iteration: 2, item_index: 4, source_file_id: "source", created_at: "2026-10-02", payload: { id: "G-9", question: "Exact raw question?", rationale: "Original rationale", status: "unknown", provenance: [{ block_id: "b1", quote: "exact quote" }] } }], relationships: [relationship] };
function response(body: object, ok = true) { return { ok, json: async () => body }; }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  refresh.mockClear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(ClaimHistory, { workspaceId: "ws", claimId: "claim" }))); }
async function click(label: string) { const button = [...host.querySelectorAll("button")].find(b => b.textContent === label); expect(button, label).toBeDefined(); await act(async () => button!.click()); }
async function reason(value: string) { await act(async () => { const input = host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }); }
it("reads only on disclosure and preserves exact content and lineage", async () => {
  const fetcher = vi.fn().mockImplementation(async () => response({ history, can_decide: true })); vi.stubGlobal("fetch", fetcher);
  await render(); expect(fetcher).not.toHaveBeenCalled(); expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  await click("Item history"); expect(fetcher).toHaveBeenCalledWith("/api/accuracy/claims/history?workspace_id=ws&claim_id=claim", expect.any(Object));
  for (const value of ["Exact raw question?", "Original rationale", "G-9", "original", "source", "run", "snapshot", "Iteration: 2", "Item index: 4", "exact quote", "old", "new"]) expect(host.textContent).toContain(value);
  expect(refresh).not.toHaveBeenCalled(); await click("Item history"); await click("Item history"); expect(fetcher).toHaveBeenCalledOnce();
});
it.each([
  { snapshot_id: "snapshot", iteration: 2, snapshotLabel: "Snapshot: snapshot", iterationLabel: "Iteration: 2" },
  { snapshot_id: null, iteration: null, snapshotLabel: "Snapshot: Judged final output (no snapshot)", iterationLabel: "Iteration: Judged final output" },
])("shows human authorship and lineage alongside generated history with snapshot $snapshot_id", async generatedOrigin => {
  const humanOrigin: HumanItemOrigin = {
    kind: "human", revision_id: "revision-edit", subject: "reviewer-subject", provider: "test",
    actor: { name: "Casey Reviewer", function: "medical_affairs" }, action: "edit",
    reason: "Correct the question using the cited source", parent_assembly_id: "parent-proposal",
    predecessor_version_id: "version", source_file_id: "source",
    provenance: [{ block_id: "b1", quote: "exact quote" }], created_at: "2026-10-03",
  };
  const generatedVersion = { ...history.versions[0], snapshot_id: generatedOrigin.snapshot_id, iteration: generatedOrigin.iteration };
  const humanVersion = {
    ...generatedVersion, id: "human-version", run_id: null, snapshot_id: null, iteration: null,
    human_origin: humanOrigin, created_at: "2026-10-03",
    payload: { ...generatedVersion.payload, question: "Corrected human question?" },
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
    history: { ...history, versions: [generatedVersion, humanVersion], relationships: [] }, can_decide: false,
  })));

  await render();
  await click("Item history");

  const rows = [...host.querySelectorAll("ol > li")];
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Original claim: original");
  expect(rows[0].textContent).toContain("Run: run");
  expect(rows[0].textContent).toContain(generatedOrigin.snapshotLabel);
  expect(rows[0].textContent).toContain(generatedOrigin.iterationLabel);
  expect(rows[0].textContent).not.toContain("Human contributor");
  for (const value of [
    "Original claim: original", "Human contributor: Casey Reviewer (medical_affairs)",
    "Change: edit", "Correct the question using the cited source", "Revision: revision-edit",
    "Parent proposal: parent-proposal", "Predecessor version: version", "Corrected human question?",
  ]) expect(rows[1].textContent).toContain(value);
  for (const value of ["Judged final output", "Run:", "Snapshot:", "Iteration:"])
    expect(rows[1].textContent).not.toContain(value);
});
it("announces loading and supports retry after failure", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response({ history: { ...history, versions: [], relationships: [] }, can_decide: false }));
  vi.stubGlobal("fetch", fetcher); await render(); await click("Item history"); expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading");
  await act(async () => finish(response({ error: "Unavailable" }, false))); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Unavailable");
  await click("Retry history"); expect(host.textContent).toContain("No recorded generated versions");
});
it.each(["Confirm identity", "Reject relationship"])("requires a reason then performs %s and reloads", async label => {
  const fetcher = vi.fn().mockImplementation(async () => response({ history, can_decide: true })); vi.stubGlobal("fetch", fetcher); await render(); await click("Item history");
  await click(label); expect(fetcher).toHaveBeenCalledOnce(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("reason");
  await reason("Reviewed exact content"); await click(label);
  const post = fetcher.mock.calls.find(call => call[0] === "/api/accuracy/claims/relationships"); expect(post).toBeDefined();
  expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ workspace_id: "ws", action: label === "Confirm identity" ? "confirm" : "reject", proposal_id: "proposal", rationale: "Reviewed exact content" });
  expect(fetcher).toHaveBeenCalledTimes(3); expect(refresh).toHaveBeenCalledOnce();
});
it("hides viewer write controls", async () => { vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({ history, can_decide: false }))); await render(); await click("Item history"); expect(host.querySelector("textarea")).toBeNull(); expect(host.textContent).not.toContain("Confirm identity"); expect(host.textContent).not.toContain("Reject relationship"); });
it("preserves decisions with actor and reason", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({ history: { ...history, relationships: [ { ...relationship, decision: "confirm", decision_actor: { name: "Contributor", function: "Reviewer" }, decision_rationale: "Exact content agrees" }, { ...relationship, id: "rejected", decision: "reject" } ] }, can_decide: true })));
  await render(); await click("Item history"); for (const text of ["Confirmed", "Rejected", "Contributor", "Exact content agrees"]) expect(host.textContent).toContain(text); expect(host.querySelector("textarea")).toBeNull();
});
it("re-proposes stale links with current server basis and preserves original IDs", async () => {
  const fetcher = vi.fn().mockImplementation(async () => response({ history: { ...history, relationships: [{ ...relationship, stale: true }] }, can_decide: true })); vi.stubGlobal("fetch", fetcher); await render(); await click("Item history");
  expect(host.textContent).not.toContain("Confirm identity"); expect(host.textContent).not.toContain("Reject relationship"); await reason("Review latest versions"); await click("Propose fresh relationship");
  expect(JSON.parse((fetcher.mock.calls[1][1] as RequestInit).body as string)).toEqual({ workspace_id: "ws", action: "propose", kind: "same_item", predecessor_ids: ["old"], successor_ids: ["new"], rationale: "Review latest versions" }); expect(fetcher).toHaveBeenCalledTimes(3);
});
it("announces write errors and permits retry without losing the reason", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ history, can_decide: true })).mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValue(response({ history, can_decide: true })); vi.stubGlobal("fetch", fetcher);
  await render(); await click("Item history"); await reason("Reviewed versions"); await click("Confirm identity"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable"); expect(host.querySelector("textarea")?.value).toBe("Reviewed versions"); await click("Confirm identity"); expect(refresh).toHaveBeenCalledOnce();
});
it("marks history-only cards Draft for review even with legacy validation and offers no validation", async () => {
  await act(async () => root.render(createElement(LedgerClaimCard, { workspaceId: "ws", claim: { id: "claim", claim_type: "gap", statement: "Draft", status: "validated", validated: true, history_only: true, source_badge: "source", validation_rationale: null } })));
  expect(host.textContent).toContain("Draft for review"); expect(host.textContent).not.toContain("Validated"); expect(host.querySelector("textarea")).toBeNull(); expect([...host.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Item history"]);
});
