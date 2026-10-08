/** @vitest-environment jsdom */
/** Canonical server page mapping → real queue/card DOM → decision request. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoveragePage, CoveragePair } from "@/accuracy/store/coverage-store";
import AccuracyCoveragePage from "@/app/admin/accuracy/coverage/page";

const { refresh, readPage } = vi.hoisted(() => ({ refresh: vi.fn(), readPage: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/platform/ai-status", () => ({ useAiEnabled: () => true }));
vi.mock("@/modules/auth/owner", () => ({ requireOwnerPage: vi.fn() }));
vi.mock("@/modules/kernel/ai-switch", () => ({ aiEnabled: async () => true }));
vi.mock("@/accuracy", () => ({ registerAccuracyStack: vi.fn() }));
vi.mock("@/accuracy/kernel/omission-pause", () => ({ assertAccuracyCanProgress: vi.fn(), AccuracyPausedError: class extends Error {} }));
vi.mock("@/accuracy/store/coverage-store", () => ({ listCoveragePage: readPage, listCoverageInventory: async () => ({ gaps: [], tactics: [] }) }));
vi.mock("@/accuracy/store/tenant", () => ({ getWorkspace: async () => ({ id: "ws", name: "Coverage review" }) }));
vi.mock("@/accuracy/store/workshop-store", () => ({ latestWorkshopSnapshot: async () => null, workshopReadiness: async () => ({ readiness: null }) }));
// Unrelated shell only; page, queue, card, links and request helper are real.
vi.mock("@/components/accuracy-app-shell", () => ({ AccuracyAppShell: ({ children }: { children: ReactNode }) => children,
  PageIntro: ({ children }: { children: ReactNode }) => children }));

let host: HTMLDivElement, root: Root;
const suggestion = { overall: "limited", rationale: "Registry covers the outcomes subset", evidence: ["block A"], run_id: "run-1", freshness: "current" as const };
function pair(overrides: Partial<CoveragePair> = {}): CoveragePair {
  const claim = { workspace_id: "ws", status: "validated", validated: true, source_file_id: "source", metadata: {}, created_at: "now", updated_at: "now" };
  return { id: "pair-gap-tactic", gap: { ...claim, id: "gap", claim_type: "gap", statement: "Need comparator evidence" },
    tactic: { ...claim, id: "tactic", claim_type: "tactic", statement: "Registry" }, overall: "pending", rationale: null,
    validated: false, gap_revision: "gap-facts", tactic_revision: "tactic-facts", freshness: "unassessed", validation_freshness: "unassessed",
    assessment_state: "successful", evidence: [], protected: false, suggestion, ...overrides };
}
async function render(pairs = [pair()], snapshot = "approved-snapshot") {
  const page: CoveragePage = { pairs, snapshot, next_cursor: null, progress: { eligible_total: pairs.length, pending: 0,
    assessed: pairs.length, validated: 0, stale: 0, unknown: 0, failed: 0, rejected: 0, missing_provenance: 0,
    excluded_claims: 0, exclusions: [], assessment_complete: true, validation_complete: false } };
  readPage.mockResolvedValue(page);
  const tree = await AccuracyCoveragePage({ searchParams: Promise.resolve({ workspace_id: "ws" }) });
  await act(async () => root.render(tree));
}
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(button => !button.closest("[hidden]") && button.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
function rationale() { return [...host.querySelectorAll<HTMLTextAreaElement>("article textarea")].find(field => !field.closest("[hidden]"))!; }
async function typeRationale(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(rationale(), value);
    rationale().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  refresh.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("renders the saved current suggestion after canonical page refresh and explicitly submits reviewed evidence awaiting approval", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, awaiting_approval: true, assembly_id: "successor" }) }));
  vi.stubGlobal("fetch", fetcher);
  await render();
  expect(host.textContent).toContain("Model suggestion: limited · current");
  expect(host.textContent).toContain(suggestion.rationale);
  expect([...host.querySelectorAll("article a")].map(a => a.getAttribute("href"))).toContain("/admin/accuracy/sources?workspace_id=ws&block_id=block%20A#block%20A");
  expect(host.textContent).toContain("successful · pending · unassessed");
  expect(rationale().value).toBe("");
  expect(fetcher).not.toHaveBeenCalled();
  await typeRationale("Human rationale before refresh");
  await render([pair({ suggestion: { ...suggestion, run_id: "run-2", rationale: "Updated source-backed suggestion" } })]);
  expect(host.textContent).toContain("Updated source-backed suggestion");
  expect(rationale().value).toBe("Human rationale before refresh");
  await click("Use suggestion");
  expect(rationale().value).toBe("Human rationale before refresh");
  expect(fetcher).not.toHaveBeenCalled();
  await click("limited");
  expect(fetcher).toHaveBeenCalledWith("/api/accuracy/coverage", expect.objectContaining({ method: "POST", body: JSON.stringify({
    workspace_id: "ws", gap_id: "gap", tactic_id: "tactic", overall: "limited", rationale: "Human rationale before refresh", action: "decide",
    expected_gap_revision: "gap-facts", expected_tactic_revision: "tactic-facts", evidence: ["block A"],
  }) }));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Successor awaiting assembly approval");
  expect(host.textContent).toContain("successful · pending · unassessed");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
});

it("shows stale suggestions without importing their rationale or evidence into a manual decision", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, awaiting_approval: true }) }));
  vi.stubGlobal("fetch", fetcher);
  await render([pair({ suggestion: { ...suggestion, freshness: "stale" }, assessment_state: "failed", failure_reason: "Provider failed on retry" })]);
  expect(host.textContent).toContain("Model suggestion: limited · stale");
  expect(host.textContent).toContain("Reassess before using");
  expect(host.textContent).toContain("Provider failed on retry");
  expect(button("Use suggestion").disabled).toBe(true);
  expect(rationale().value).toBe("");
  await typeRationale("Independent human decision");
  await click("limited");
  expect(fetcher).toHaveBeenCalledWith("/api/accuracy/coverage", expect.objectContaining({ body: expect.stringContaining('"evidence":[]') }));
});

it("blocks an adopted suggestion after refresh makes it stale while preserving human rationale", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, awaiting_approval: true }) }));
  vi.stubGlobal("fetch", fetcher);
  await render();
  await click("Use suggestion");
  expect(rationale().value).toBe(suggestion.rationale);
  await typeRationale("Human refinement of the suggestion");
  await render([pair({ suggestion: { ...suggestion, freshness: "stale" } })], "new-approved-snapshot");
  expect(rationale().value).toBe("Human refinement of the suggestion");
  expect(button("limited").disabled).toBe(true);
  await click("limited");
  expect(fetcher).not.toHaveBeenCalled();
  await click("Use manual decision");
  expect(rationale().value).toBe("Human refinement of the suggestion");
  await click("limited");
  expect(fetcher).toHaveBeenCalledWith("/api/accuracy/coverage", expect.objectContaining({ body: expect.stringContaining('"evidence":[]') }));
});

it("preserves each pair's human draft during navigation without carrying the earlier suggestion to another pair", async () => {
  const second = pair({ id: "pair-other", gap: { ...pair().gap, id: "other-gap", statement: "Independent need" },
    suggestion: { ...suggestion, rationale: "A different source supports this need", evidence: ["other-block"], run_id: "other-run" } });
  await render([pair(), second]);
  await typeRationale("First pair human draft");
  await click("Skip / next");
  expect(rationale().value).toBe("");
  expect(rationale().closest("article")?.textContent).toContain("A different source supports this need");
  expect(rationale().closest("article")?.textContent).not.toContain(suggestion.rationale);
  await typeRationale("Second pair human draft");
  await click("Previous");
  expect(rationale().value).toBe("First pair human draft");
  await click("Skip / next");
  expect(rationale().value).toBe("Second pair human draft");
});

it("uses the existing assist through the same explicit review controls without overwriting human text or live coverage", async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("/assist") ? {
    ok: true, mode: "llm", run_id: "assist-run", expected_gap_revision: "gap-facts", expected_tactic_revision: "tactic-facts",
    suggestion: { overall: "partial", schema_overall: "partial", rationale: "Fresh assist rationale", confidence: 0.9, quote_block_ids: ["assist-block"] },
  } : { ok: true, awaiting_approval: true } }));
  vi.stubGlobal("fetch", fetcher);
  await render();
  await typeRationale("Human assessment in progress");
  await click("Suggest with LLM");
  expect(rationale().value).toBe("Human assessment in progress");
  expect(host.textContent).toContain("Model suggestion: partial · current");
  expect(host.textContent).toContain("Assist (llm) · confidence 0.90");
  expect(host.textContent).not.toContain(suggestion.rationale);
  expect(host.textContent).toContain("successful · pending · unassessed");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click("Use suggestion");
  await click("partial");
  expect(fetcher).toHaveBeenLastCalledWith("/api/accuracy/coverage", expect.objectContaining({ body: expect.stringContaining('"evidence":["assist-block"]') }));
  expect(rationale().value).toBe("Human assessment in progress");
});

it("does not apply a late assist response to another pair or a refreshed snapshot", async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const second = pair({ id: "second", gap: { ...pair().gap, id: "other-gap" }, suggestion: undefined, assessment_state: "pending" });
  await render([pair(), second]);
  await click("Suggest with LLM");
  await click("Skip / next");
  await render([pair(), second], "new-snapshot");
  await act(async () => finish({ ok: true, json: async () => ({ ok: true, expected_gap_revision: "gap-facts", expected_tactic_revision: "tactic-facts",
    suggestion: { overall: "full", rationale: "Old in-flight suggestion", confidence: 0.9, quote_block_ids: ["old-block"] } }) }));
  expect(rationale().closest("article")?.textContent).not.toContain("Old in-flight suggestion");
  expect(rationale().value).toBe("");
  await click("Previous");
  expect(rationale().closest("article")?.textContent).not.toContain("Old in-flight suggestion");
  expect(rationale().closest("article")?.textContent).toContain(suggestion.rationale);
});

it("refuses an assist from different factual revisions and protects existing human decisions", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, expected_gap_revision: "different-facts", expected_tactic_revision: "tactic-facts",
    suggestion: { overall: "full", rationale: "Wrong revision", confidence: 0.9, quote_block_ids: ["wrong-block"] } }) }));
  vi.stubGlobal("fetch", fetcher);
  await render();
  await click("Suggest with LLM");
  expect(host.textContent).toContain("Coverage inputs changed");
  expect(host.textContent).not.toContain("Wrong revision");
  await render([pair({ protected: true, rationale: "Earlier human rationale", evidence: ["human-block"] })]);
  expect(rationale().value).toBe("Earlier human rationale");
  expect(button("Suggest with LLM").disabled).toBe(true);
  expect(button("Use suggestion").disabled).toBe(true);
  await typeRationale("Human correction");
  await click("limited");
  expect(fetcher).toHaveBeenLastCalledWith("/api/accuracy/coverage", expect.objectContaining({ body: expect.stringContaining('"evidence":["human-block"]') }));
});
