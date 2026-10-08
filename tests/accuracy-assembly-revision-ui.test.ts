/** @vitest-environment jsdom */
/** Exercise contributor revisions through labeled, real React DOM controls. */
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Assembly } from "@/accuracy/domain/assembly";
import { AssemblyHistory } from "@/components/accuracy/assembly-history";

let host: HTMLDivElement;
let root: Root;
const spans = [
  { source_file_id: "source-1", block_id: "block-1", quote: "first source quote", char_start: 0, char_end: 18 },
  { source_file_id: "source-1", block_id: "block-2", quote: "second source quote" },
];
const gap = {
  id: "gap-v1", claim_id: "gap-claim", canonical_claim_id: "gap-canonical", claim_type: "gap" as const,
  source_file_id: "source-1", run_id: "run-gap", snapshot_id: "snapshot-gap", iteration: 1,
  item_index: 0, created_at: "2026-10-03T09:00:00Z", reason: "Selected agent output",
  payload: { id: "G-1", statement: "Original gap", external_id: "EXT-1", provenance: spans },
};
const tactic = {
  ...gap, id: "tactic-v1", claim_id: "tactic-claim", canonical_claim_id: "tactic-canonical", claim_type: "tactic" as const,
  payload: { id: "T-1", name: "Original tactic", type: "registry", status: "ongoing", evidence_question: "Original question", origin: "inventory", provenance: spans },
};
const baseline: Assembly = {
  id: "baseline", workspace_id: "ws", fingerprint: "fp-baseline", created_at: "2026-10-03T09:00:00Z",
  actor: { name: "Agent", function: "medical_affairs" }, source_file_ids: ["source-1"],
  items: [gap, tactic], mappings: [], coverage: [], linking_complete: true,
  extraction_runs: [
    { call_kind: "need_extract", run_id: "run-gap", source_file_id: "source-1", item_count: 1, outcome: "items", evaluation_context: "production" },
    { call_kind: "inventory_extract", run_id: "run-tactic", source_file_id: "source-1", item_count: 1, outcome: "items", evaluation_context: "production" },
  ],
  output: { gaps: [gap.payload], tactics: [tactic.payload] },
  checks: { checker_version: "v1", status: "passed", findings: [] },
};
const revision = {
  id: "revision-1", workspace_id: "ws", baseline_assembly_id: "baseline", parent_assembly_id: "baseline",
  action: "edit", reason: "Correct the gap", author: { subject: "user", provider: "test", actor: { name: "Contributor", function: "medical_affairs" }, role: "contributor" },
  predecessor_version_id: "gap-v1", successor_version_id: "human-gap", source_file_id: "source-1", provenance: spans, created_at: "2026-10-03T10:00:00Z",
};
const successor: Assembly = { ...baseline, id: "successor", fingerprint: "fp-successor", items: [{ ...gap, id: "human-gap", run_id: null, snapshot_id: null, iteration: null, human_origin: { kind: "human", revision_id: "revision-1", subject: "user", provider: "test", actor: { name: "Contributor", function: "medical_affairs" }, action: "edit", reason: "Correct the gap", parent_assembly_id: "baseline", predecessor_version_id: "gap-v1", source_file_id: "source-1", provenance: spans, created_at: "2026-10-03T10:00:00Z" } }, tactic] };
const blocks = spans.map(span => ({ id: span.block_id, source_file_id: span.source_file_id, text: span.quote }));
function state(assembly = baseline, error: string | null = null) {
  return { revision: assembly.id === "baseline" ? null : revision, baseline_assembly_id: "baseline", current_head_id: assembly.id, is_current: true, linking_error: error, can_retry: !assembly.linking_complete };
}
function detail(assembly = baseline, permissions = { can_revise: true, can_review: true, can_retry_revision: false }, error: string | null = null) {
  return { assembly, revision_state: state(assembly, error), evidence_blocks: blocks, ...permissions,
    review_state: { assembly_id: assembly.id, fingerprint: assembly.fingerprint, checks_fingerprint: "checks", status: "pending", head_status: "current", expected_review_id: null, latest_decision: null, checks: assembly.checks, advisories: [] } };
}
function response(body: object, ok = true, status = ok ? 200 : 400) { return { ok, status, json: async () => body }; }
function button(label: string) { return [...host.querySelectorAll("button")].find(candidate => candidate.textContent === label)!; }
async function click(label: string) {
  expect(button(label), label).toBeDefined();
  await act(async () => button(label).click());
}
async function field(labelText: string, value: string) {
  const label = [...host.querySelectorAll("label")].find(candidate => candidate.querySelector("span")?.textContent === labelText);
  expect(label, labelText).toBeDefined();
  const control = label!.querySelector("input,textarea,select")! as HTMLInputElement;
  const proto = control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : control.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function open(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(AssemblyHistory, { workspaceId: "ws" })));
  await click("Complete proposals");
  await click("Inspect proposal baseline");
}
function initial() { return vi.fn().mockResolvedValueOnce(response({ assemblies: [baseline], revision_states: { baseline: state() } })).mockResolvedValueOnce(response(detail())); }
function postBody(fetcher: ReturnType<typeof vi.fn>) { return JSON.parse(fetcher.mock.calls.find(call => call[1]?.method === "POST")![1].body); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("requires a reason and edits only the requested gap while preserving every original evidence span", async () => {
  const fetcher = initial().mockResolvedValueOnce(response({ assembly: successor, revision, revision_state: state(successor) }))
    .mockResolvedValueOnce(response({ assemblies: [successor, baseline], revision_states: { successor: state(successor), baseline: state() } }))
    .mockResolvedValueOnce(response(detail(successor)));
  await open(fetcher);
  expect(host.textContent).toContain("Agent baseline");
  await click("Edit gap gap-v1");
  expect(button("Save revision").disabled).toBe(true);
  await field("Gap statement", "Corrected gap");
  await field("Reason for change", "  Correct the gap  ");
  await click("Save revision");
  expect(postBody(fetcher)).toEqual({ action: "revise", workspace_id: "ws", parent_assembly_id: "baseline", expected_fingerprint: "fp-baseline", expected_head_id: "baseline",
    change: { action: "edit", reason: "Correct the gap", item_version_id: "gap-v1", content: { claim_type: "gap", source_file_id: "source-1", payload: { statement: "Corrected gap", external_id: "EXT-1", provenance: spans } } } });
  expect(host.textContent).toContain("Human revision · Linking complete");
  expect(host.textContent).toContain("Human contributor: Contributor");
  expect(host.textContent).toContain("Fingerprint: fp-successor");
  expect(host.querySelector("button[aria-label='Approve proposal']")).not.toBeNull();
  expect(host.textContent).not.toContain("Judged final output (no snapshot)");
});

it("preserves untouched tactic schema fields and sends a human edit without generated IDs", async () => {
  const fetcher = initial().mockResolvedValueOnce(response({ error: "stop after body" }, false));
  await open(fetcher); await click("Edit tactic tactic-v1");
  await field("Tactic name", "Corrected tactic"); await field("Reason for change", "Fix name"); await click("Save revision");
  expect(postBody(fetcher).change.content.payload).toEqual({ name: "Corrected tactic", type: "registry", status: "ongoing", evidence_question: "Original question", origin: "inventory", provenance: spans });
});

it.each(["gap", "tactic"])("adds a %s using authorized source blocks and schema-specific controls", async kind => {
  const fetcher = initial().mockResolvedValueOnce(response({ error: "stop after body" }, false));
  await open(fetcher); await click(`Add ${kind}`);
  await field("Reason for change", "Missing item");
  await field(kind === "gap" ? "Gap statement" : "Tactic name", "New item");
  if (kind === "tactic") { await field("Tactic type", "slr"); await field("Tactic status", "planned"); await field("Evidence question", "New question"); }
  expect(button("Save revision").disabled).toBe(true);
  await field("Evidence block 1", "block-1");
  expect(host.textContent).toContain("first source quote");
  await field("Evidence quote 1", "first source quote"); await click("Save revision");
  const content = postBody(fetcher).change.content;
  expect(content.claim_type).toBe(kind);
  expect(content.source_file_id).toBe("source-1");
  expect(content.payload.provenance).toEqual([{ source_file_id: "source-1", block_id: "block-1", quote: "first source quote" }]);
  expect(content.payload).not.toHaveProperty("id");
  if (kind === "tactic") expect(content.payload).toMatchObject({ type: "slr", status: "planned", evidence_question: "New question", origin: "inventory" });
});

it.each(["gap", "tactic"])("requires a reason for removing a %s and never sends destructive deletion or authored lineage", async kind => {
  const fetcher = initial().mockResolvedValueOnce(response({ error: "stop after body" }, false));
  await open(fetcher); await click(`Remove ${kind} ${kind}-v1`);
  expect(button("Save revision").disabled).toBe(true);
  expect(host.textContent).toContain("History is retained");
  await field("Reason for change", "Duplicate item"); await click("Save revision");
  expect(postBody(fetcher).change).toEqual({ action: "remove", item_version_id: `${kind}-v1`, reason: "Duplicate item" });
});

it("saves failed linking history, navigates to it, and retries using its exact new bindings", async () => {
  const incomplete = { ...successor, id: "failed", fingerprint: "fp-failed", linking_complete: false };
  const fetcher = initial().mockResolvedValueOnce(response({ assembly: incomplete, revision, revision_state: state(incomplete, "Provider unavailable") }))
    .mockResolvedValueOnce(response({ assemblies: [incomplete, baseline], revision_states: { failed: state(incomplete, "Provider unavailable") } }))
    .mockResolvedValueOnce(response(detail(incomplete, { can_revise: false, can_review: false, can_retry_revision: true }, "Provider unavailable")))
    .mockResolvedValueOnce(response({ assembly: successor, revision, revision_state: state(successor) }))
    .mockResolvedValueOnce(response({ assemblies: [successor, incomplete, baseline], revision_states: { successor: state(successor), failed: state(incomplete) } }))
    .mockResolvedValueOnce(response(detail(successor)));
  await open(fetcher); await click("Remove gap gap-v1"); await field("Reason for change", "Duplicate"); await click("Save revision");
  expect(host.textContent).toContain("Human revision · Linking failed");
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Provider unavailable");
  expect(host.textContent).not.toContain("Add gap");
  await click("Retry revision linking");
  const posts = fetcher.mock.calls.filter(call => call[1]?.method === "POST");
  expect(JSON.parse(posts[1][1].body)).toEqual({ action: "retry_revision", workspace_id: "ws", assembly_id: "failed", expected_fingerprint: "fp-failed", expected_head_id: "failed" });
  expect(host.textContent).toContain("Fingerprint: fp-successor");
});

it.each([{ can_revise: false, can_review: false, can_retry_revision: false }, { can_revise: false, can_review: true, can_retry_revision: false }])("uses only server mutation permissions while keeping inspection and separate review access", async permissions => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ assemblies: [baseline] })).mockResolvedValueOnce(response(detail(baseline, permissions)));
  await open(fetcher);
  expect(host.textContent).toContain("Original gap"); expect(host.textContent).not.toContain("Add gap"); expect(host.textContent).not.toContain("Edit gap");
  expect(Boolean(host.querySelector("button[aria-label='Approve proposal']"))).toBe(permissions.can_review);
});

it("invalidates both revision and approval controls on conflict, retaining inspectable content until fresh detail", async () => {
  const fetcher = initial().mockResolvedValueOnce(response({ error: "Parent is stale" }, false, 409))
    .mockResolvedValueOnce(response({ error: "Detail unavailable" }, false, 503)).mockResolvedValueOnce(response(detail()));
  await open(fetcher); await field("Review rationale", "Ready");
  await click("Remove gap gap-v1"); await field("Reason for change", "Duplicate"); await click("Save revision");
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Parent is stale");
  expect(host.textContent).toContain("Original gap");
  expect(host.querySelector("button[aria-label='Approve proposal']")?.hasAttribute("disabled")).toBe(true);
  expect(button("Save revision")?.disabled ?? true).toBe(true);
  await click("Refresh proposal");
  expect(host.textContent).toContain("Detail unavailable"); expect(host.textContent).not.toContain("Save revision");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
  await click("Retry proposal"); expect(host.textContent).toContain("Add gap");
});

it("keeps mutation controls invalid after a successful save whose successor refresh fails", async () => {
  const fetcher = initial().mockResolvedValueOnce(response({ assembly: successor, revision }))
    .mockResolvedValueOnce(response({ error: "List unavailable" }, false, 503)).mockResolvedValueOnce(response({ error: "Successor unavailable" }, false, 503));
  await open(fetcher); await click("Remove gap gap-v1"); await field("Reason for change", "Duplicate"); await click("Save revision");
  expect(host.textContent).toContain("Successor unavailable");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
  expect(host.textContent).not.toContain("Save revision");
});

it("serializes contributor mutations and review decisions and ignores responses after switching workspace", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const fetcher = initial().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open(fetcher); await field("Review rationale", "Ready");
  await click("Remove gap gap-v1"); await field("Reason for change", "Duplicate"); await click("Save revision");
  expect(host.querySelector("button[aria-label='Approve proposal']")?.hasAttribute("disabled")).toBe(true);
  expect(host.querySelector("[role='status']")?.textContent).toContain("Saving revision");
  await click("Approve proposal"); expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  await act(async () => root.render(createElement(StrictMode, null, createElement(AssemblyHistory, { workspaceId: "next" }))));
  await act(async () => finish(response({ assembly: successor, revision })));
  expect(host.textContent).not.toContain("successor"); expect(fetcher).toHaveBeenCalledTimes(3);
});

it("preserves untouched evidence offsets and clears old offsets only when a quote changes", async () => {
  const fetcher = initial().mockResolvedValueOnce(response({ error: "stop after body" }, false));
  await open(fetcher); await click("Edit gap gap-v1");
  await field("Reason for change", "Correct evidence span");
  await field("Evidence quote 1", "source quote");
  await click("Save revision");
  expect(postBody(fetcher).change.content.payload.provenance).toEqual([
    { source_file_id: "source-1", block_id: "block-1", quote: "source quote" }, spans[1],
  ]);
});

it("allows multiple evidence spans and explicit span removal, and rejects blank reasons or unsupported quotes", async () => {
  const fetcher = initial().mockResolvedValueOnce(response({ error: "stop after body" }, false));
  await open(fetcher); await click("Add gap");
  await field("Gap statement", "New gap"); await field("Reason for change", "   ");
  await field("Evidence block 1", "block-1"); await field("Evidence quote 1", "first source quote");
  expect(button("Save revision").disabled).toBe(true);
  await field("Reason for change", "Include omitted evidence");
  await click("Add evidence quote"); await field("Evidence block 2", "block-2"); await field("Evidence quote 2", "invented quote");
  expect(button("Save revision").disabled).toBe(true);
  await field("Evidence quote 2", "second source quote");
  expect(button("Save revision").disabled).toBe(false);
  await click("Remove evidence quote 1"); await click("Save revision");
  expect(postBody(fetcher).change.content.payload.provenance).toEqual([spans[1]]);
});

it("keeps failed revisions read-only when server denies retry even though revision metadata permits it", async () => {
  const incomplete = { ...successor, id: "failed", linking_complete: false };
  const fetcher = vi.fn().mockResolvedValueOnce(response({ assemblies: [incomplete], revision_states: { failed: state(incomplete, "Provider unavailable") } }))
    .mockResolvedValueOnce(response(detail(incomplete, { can_revise: false, can_review: false, can_retry_revision: false }, "Provider unavailable")));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(AssemblyHistory, { workspaceId: "ws" })));
  await click("Complete proposals"); await click("Inspect proposal failed");
  expect(host.textContent).toContain("Provider unavailable");
  expect(host.textContent).not.toContain("Retry revision linking");
  expect(host.textContent).not.toContain("Add gap");
});

it("navigates between a human successor and its preserved stale agent baseline without approval fallback", async () => {
  const oldState = { ...state(), is_current: false, current_head_id: "successor" };
  const fetcher = initial().mockResolvedValueOnce(response({ assembly: successor, revision, revision_state: state(successor) }))
    .mockResolvedValueOnce(response({ assemblies: [successor, baseline], revision_states: { successor: state(successor), baseline: oldState } }))
    .mockResolvedValueOnce(response(detail(successor)))
    .mockResolvedValueOnce(response({ ...detail(baseline, { can_revise: false, can_review: false, can_retry_revision: false }), revision_state: oldState }))
    .mockResolvedValueOnce(response(detail(successor)));
  await open(fetcher); await click("Remove gap gap-v1"); await field("Reason for change", "Duplicate"); await click("Save revision");
  await click("Inspect agent baseline");
  expect(host.textContent).toContain("Fingerprint: fp-baseline");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
  expect(host.textContent).not.toContain("Save revision");
  await click("Inspect current successor"); expect(host.textContent).toContain("Fingerprint: fp-successor");
});

it("renders an unseen current successor from fresh detail without requiring a list refresh", async () => {
  const staleDetail = { ...detail(baseline, { can_revise: false, can_review: false, can_retry_revision: false }), revision_state: { ...state(), is_current: false, current_head_id: "successor" } };
  const changedSuccessor = { ...successor, items: [{ ...successor.items[0], payload: { ...gap.payload, statement: "Unseen corrected gap" } }, tactic] };
  const fetcher = vi.fn().mockResolvedValueOnce(response({ assemblies: [baseline] }))
    .mockResolvedValueOnce(response(staleDetail))
    .mockResolvedValueOnce(response(detail(changedSuccessor)))
    .mockResolvedValueOnce(response(staleDetail));
  await open(fetcher); await click("Inspect current successor");
  expect(host.textContent).toContain("Fingerprint: fp-successor");
  expect(host.textContent).toContain("Unseen corrected gap");
  expect(host.textContent).not.toContain("Fingerprint: fp-baseline");
  expect(host.textContent).toContain("Add gap");
  await field("Review rationale", "Approve the exact successor");
  expect(button("Approve proposal").disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher).toHaveBeenLastCalledWith("/api/accuracy/assemblies?workspace_id=ws&assembly_id=successor", { cache: "no-store" });
  await click("Inspect agent baseline");
  expect(host.textContent).toContain("Fingerprint: fp-baseline");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
});

it("announces unseen-successor loading and failed detail with visible retry and no enabled mutations or reviews", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const staleDetail = { ...detail(baseline, { can_revise: false, can_review: false, can_retry_revision: false }), revision_state: { ...state(), is_current: false, current_head_id: "successor" } };
  const fetcher = vi.fn().mockResolvedValueOnce(response({ assemblies: [baseline] }))
    .mockResolvedValueOnce(response(staleDetail))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(response(detail(successor)));
  await open(fetcher); await click("Inspect current successor");
  expect(host.querySelector("[role='status']")?.textContent).toContain("Loading proposal detail");
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
  expect(host.textContent).not.toContain("Add gap");
  await act(async () => finish(response({ error: "Current successor unavailable" }, false, 503)));
  expect(host.querySelector("[role='alert']")?.textContent).toContain("Current successor unavailable");
  expect(button("Retry proposal").disabled).toBe(false);
  expect(host.querySelector("button[aria-label='Approve proposal']")).toBeNull();
  expect(host.textContent).not.toContain("Save revision");
  await click("Retry proposal");
  expect(host.textContent).toContain("Fingerprint: fp-successor");
  expect(host.textContent).toContain("Add gap");
  expect(fetcher).toHaveBeenLastCalledWith("/api/accuracy/assemblies?workspace_id=ws&assembly_id=successor", { cache: "no-store" });
});
