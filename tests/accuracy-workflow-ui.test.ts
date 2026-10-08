/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LedgerClaimCard } from "@/components/accuracy/ledger-claim-card";
import { emptyGapStructuredFields } from "@/accuracy/domain/structured-fields";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/platform/ai-status", () => ({ useAiEnabled: () => true }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("shows sourced structured facts, unknown reasons and stale validation without calling it current", async () => {
  const structured = { ...emptyGapStructuredFields("not_stated"), description: { state: "known" as const, value: "Comparative evidence missing", provenance: [{ source_file_id: "source", block_id: "block", quote: "Comparative evidence missing" }] } };
  const claim = { id: "gap", claim_type: "gap", statement: "Need evidence", status: "draft", validated: false, source_badge: "source", validation_rationale: "Earlier decision", structured, validation_freshness: "stale", computed_status: "partial", effective_status: "open", override_stale: true };
  await act(async () => root.render(createElement(LedgerClaimCard, { workspaceId: "ws", claim })));
  expect(host.textContent).toContain("Description: Comparative evidence missing");
  expect(host.textContent).toContain("Indication: Unknown (not_stated)");
  expect(host.textContent).toContain("Validation: stale");
  expect(host.textContent).toContain("Computed: partial · Effective: open");
  expect(host.textContent).toContain("stale override");
  expect([...host.querySelectorAll("a")].map(a => a.getAttribute("href"))).toContain("/admin/accuracy/sources?workspace_id=ws&block_id=block#block");
});
it("offers an evidence-reviewed split for a currently validated computed Partial gap", async () => {
  await act(async () => root.render(createElement(LedgerClaimCard, { workspaceId: "ws", claim: { id: "gap", claim_type: "gap", statement: "Need comparator and outcomes", status: "validated", validated: true, source_badge: "source", validation_rationale: "Verified", validation_freshness: "current", computed_status: "partial", effective_status: "partial" } })));
  expect([...host.querySelectorAll("button")].some(b => b.textContent === "Resolve Partial gap")).toBe(true);
});
it.each(["unknown", "stale"])("offers human revalidation when a legacy validated flag has %s freshness", async freshness => {
  await act(async () => root.render(createElement(LedgerClaimCard, { workspaceId: "ws", claim: { id: "gap", claim_type: "gap", statement: "Need evidence", status: "validated", validated: true, source_badge: "source", validation_rationale: "Earlier review", validation_freshness: freshness } })));
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Validate")).toBe(true);
  expect([...host.querySelectorAll("span")].some(span => span.textContent === "Validated")).toBe(false);
});

import { PlanPriorityCard } from "@/components/accuracy/plan-priority-card";
import { ClaimSplitControls } from "@/components/accuracy/claim-split-controls";
it("requires a reload when a split proposal was generated from different inputs than the displayed evidence", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => ({ ok: true, json: async () => options
    ? { proposal: { workspace_id: "ws", parent_gap_id: "gap", expected_parent_revision: "new-facts", expected_coverage_revision: "coverage", confirmed: false,
      addressed_name: "Outcomes", addressed_statement: "Need outcomes", open_name: "Comparator", open_statement: "Need comparator", addressed_tactic_ids: [], addressed_evidence: [], open_evidence: [], uncovered_dimensions: [], confidence: 90, rationale: ["New factual inputs"] } }
    : { expected_parent_revision: "shown-facts", expected_coverage_revision: "coverage", supporting_coverage: [], permitted_evidence: [] } })));
  await act(async () => root.render(createElement(ClaimSplitControls, { workspaceId: "ws", gapId: "gap" })));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Resolve Partial gap")!.click());
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Suggest a split")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Split inputs changed");
  expect(host.querySelector("textarea")).toBeNull();
});
it("reads canonical S8 inputs before human validation and keeps selected revision separate from global config revision", async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => ({ ok: true, status: 200, json: async () => options ? { ok: true } : {
    ok: true, eligible: true, expected_input_revision: "facts", expected_config_revision: "selected-pair", config: { revision: "global" },
    axes: [{ id: "cost", label: "Effort", higher_is_priority: false }, { id: "impact", label: "Impact" }], x_axis: "cost", y_axis: "impact", pair_chosen: true,
    context: {}, considerations: {}, references: [], limitations: ["Missing evidence"], placements: [],
  } }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(PlanPriorityCard, { workspaceId: "ws", claimId: "gap", statement: "Need comparator", priority: null, validated: true, status: "open" })));
  const open = [...host.querySelectorAll("button")].find(b => b.textContent === "Review S8 priority");
  expect(open).toBeDefined();
  await act(async () => open!.click());
  expect(host.textContent).toContain("Effort (lower is higher priority)");
  expect(host.textContent).toContain("Missing evidence");
  const field = host.querySelector('[aria-label="S8 rationale"]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Comparator drives the decision");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Validate working priority")!.click());
  const posted = fetcher.mock.calls.find(call => call[1]?.method === "POST")!;
  expect(JSON.parse(String(posted[1]?.body))).toMatchObject({ action: "validate", gap_id: "gap", expected_input_revision: "facts", expected_config_revision: "selected-pair", band: "medium", rationale: "Comparator drives the decision" });
});

import { claimFieldSnapshot } from "@/accuracy/domain/claim-fields";
import { gapStructuredFieldsSchema } from "@/accuracy/domain/structured-fields";
it("shows category, document resolution and interview attribution without inventing a missing attachment or speaker", async () => {
  const span = { source_file_id: "source", block_id: "block", quote: "Clinical efficacy requires comparator evidence; report ABC is unavailable." };
  const fields = gapStructuredFieldsSchema.parse({ ...emptyGapStructuredFields("not_stated"), category: { state: "known", value: { source_label: "clinical efficacy" }, provenance: [span] },
    supporting_documents: { state: "known", value: [{ title: "Report ABC", document_id: "ABC", resolution: "unresolved", source_file_id: null }, { title: "Known source", document_id: null, resolution: "resolved", source_file_id: "source" }], provenance: [span] },
    interview_quotes: { state: "known", value: [{ quote: span, speaker: { state: "unknown", value: null, reason: "not_attributed", provenance: [] }, role: { state: "unknown", value: null, reason: "not_stated", provenance: [] } }], provenance: [span] } });
  await act(async () => root.render(createElement(LedgerClaimCard, { workspaceId: "ws", claim: { id: "gap", claim_type: "gap", statement: "Need comparator", status: "draft", validated: false, source_badge: "source", validation_rationale: null, structured: fields } })));
  expect(host.textContent).toContain("Category: clinical efficacy (efficacy)");
  expect(host.textContent).toContain("Report ABC (unresolved · ABC)");
  expect(host.textContent).toContain("speaker: Unknown (not_attributed); role: Unknown (not_stated)");
  expect([...host.querySelectorAll("a")].filter(link => link.textContent === "Report ABC")).toHaveLength(0);
  expect([...host.querySelectorAll("a")].find(link => link.textContent === "Known source")?.getAttribute("href")).toBe("/admin/accuracy/sources?workspace_id=ws&source_file_id=source#source-source");
});
it("keeps an explicitly unknown tactic lifecycle visible in the existing editor", () => {
  expect(claimFieldSnapshot({ statement: "Registry", status: "draft", metadata: { tactic_status: "unknown" } }).tactic_status).toBe("unknown");
});
it("shows fresh S8 candidate rationale and skip reasons separately from persisted working decisions", async () => {
  const read = { ok: true, eligible: true, expected_input_revision: "facts", expected_config_revision: "pair", config: { revision: "global" }, axes: [], x_axis: "x", y_axis: "y", pair_chosen: true, context: {}, considerations: {}, references: [], limitations: [], placements: [] };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => ({ ok: true, status: 200, json: async () => options ? { ok: true, mode: "llm", suggestions: [{ gap_id: "gap", suggested_band: "defer", rationale: "Fixture missing comparator" }], skipped: [{ gap_id: "other", reason: "computed_partial" }] } : read })));
  await act(async () => root.render(createElement(PlanPriorityCard, { workspaceId: "ws", claimId: "gap", statement: "Need comparator", priority: null, validated: true, status: "open" })));
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Review S8 priority")!.click());
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Suggest S8 priority")!.click());
  expect(host.textContent).toContain("Fresh suggestion: defer · Fixture missing comparator");
  expect(host.textContent).toContain("Skipped other: computed_partial");
  expect(host.textContent).toContain("Human working decision: None · Validation: unvalidated");
});
it("does not describe an unvalidated model placement as a human working decision", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ eligible: true, config: { revision: "global" }, expected_input_revision: "facts", expected_config_revision: "pair", axes: [], x_axis: "x", y_axis: "y", pair_chosen: true, context: {}, considerations: {}, references: [], limitations: [], placements: [{ gap_id: "gap", band: "defer", suggested_band: "defer", suggested_rationale: "Missing comparator", validated: false, validation: null, human_revision: null, history: [], axis_scores: {} }] }) })));
  await act(async () => root.render(createElement(PlanPriorityCard, { workspaceId: "ws", claimId: "gap", statement: "Need comparator", priority: null, validated: true, status: "open" })));
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Review S8 priority")!.click());
  expect(host.textContent).toContain("Suggestion: defer · Missing comparator");
  expect(host.textContent).toContain("Human working decision: None · Validation: unvalidated");
});
it("clears a fresh candidate display when reloaded priority inputs have changed", async () => {
  let revision = "facts";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => ({ ok: true, json: async () => options ? { suggestions: [{ gap_id: "gap", suggested_band: "defer", rationale: "Earlier inputs" }], skipped: [] } : {
    eligible: true, config: { revision: "global" }, expected_input_revision: revision, expected_config_revision: "pair", axes: [], x_axis: "x", y_axis: "y", pair_chosen: true, context: {}, considerations: {}, references: [], limitations: [], placements: [],
  } })));
  await act(async () => root.render(createElement(PlanPriorityCard, { workspaceId: "ws", claimId: "gap", statement: "Need comparator", priority: null, validated: true, status: "open" })));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Review S8 priority")!.click());
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Suggest S8 priority")!.click());
  expect(host.textContent).toContain("Fresh suggestion: defer");
  revision = "changed-facts";
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Reload current priority inputs")!.click());
  expect(host.textContent).not.toContain("Fresh suggestion: defer");
});

it("presents copied managed split history as read-only without offering a source inverse", async () => {
  const { SplitOperationHistory } = await import("@/components/accuracy/claim-split-controls");
  await act(async () => root.render(createElement(SplitOperationHistory, { workspaceId: "copy", operations: [{ id: "archived-split",
    parent_gap_id: "parent", addressed_gap_id: "addressed", open_residual_gap_id: "residual", state: "archived",
    actor: { name: "Source reviewer" }, rationale: "Historical review", created_at: "2026-10-08", rolled_back_at: null }] })));
  expect(host.textContent).toContain("Copied history — read only");
  expect(host.textContent).toContain("Source approvals do not authorize this copy");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Rollback split")).toBe(false);
});
