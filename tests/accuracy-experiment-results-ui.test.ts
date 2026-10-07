/** @vitest-environment jsdom */
/** Check readable, source-scoped experiment history through rendered React DOM. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExperimentResultsReport } from "@/accuracy/experiments/results-report";
import { ExperimentResults } from "@/components/accuracy/experiment-results";
import AccuracyExperimentsPage from "@/app/accuracy/experiments/page";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/accuracy-app-shell", () => ({ AccuracyAppShell: ({ children }: { children: React.ReactNode }) => children }));

let host: HTMLDivElement;
let root: Root;
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
const report: ExperimentResultsReport = {
  schema_version: "experiment-results-v1", source_workspace_id: "source-a",
  repeat_series: [{ repeat_key: "repeat-a", member_ids: ["pass:p1:2", "pass:p2:2"], rationale: "Two retained comparisons; every member must gain." }],
  entries: [{ id: "pass:p1:2", kind: "pass_candidate", created_at: "2026-10-06T10:00:00Z",
    attribution: { label: "Observed gain", scope: "source_gold", reasons: ["One matched source-gold gain."] },
    matched: true, mismatch_reasons: [], repeat_key: "repeat-a", experiment_ids: ["baseline-a", "candidate-a"], call_ids: ["call-a"],
    evidence: { experiments: [{ id: "baseline-a", status: "completed", source_fingerprint: "document-v1", baseline_fingerprint: "baseline-v1", pack_id: "gold-a", pack_fingerprint: "gold-v1", evaluator_version: "gold-evaluator-v1", calls: [{ call_id: "call-a", version_index: 0, input: { prompt: "exact input" }, output: { gaps: ["exact output"] } }], evaluations: [] }] as never,
      pass_comparison: { comparison_id: "p1", comparison_evaluator_version: "pass-evaluator-v1", matched: true, mismatch_reasons: [], loaded_pack_identity: { pack_id: "gold-a", pack_fingerprint: "gold-v1", matches_retained: true }, recommendation: null,
        conditions: [{ experiment_id: "baseline-a", pass_count: 1, status: "completed", eligibility: "eligible", reasons: [], identity: {}, calls: [], totals: { distinct_exact_found_count: 1, distinct_exact_found_keys: ["gap-a"], distinct_exact_must_find_found_count: 1, distinct_exact_must_find_keys: ["gap-a"], summed_call_outcomes: { found: 1, partial: 0, missed: 1, wrong: 0 }, summed_call_must_find_outcomes: null, cost_usd: 0, latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } },
          { experiment_id: "candidate-a", pass_count: 2, status: "completed", eligibility: "eligible", reasons: [], identity: {}, calls: [{ call_id: "call-a", call_kind: "need_extract", lineage_key: "gap", runtime: { call_id: "call-a", module_id: "module-a", module_version: "v2", route: {}, status: "ok", duration_ms: null, cost_usd: null, token_usage: null, events: [] }, full_call_metering: { cost_usd: 0, latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, versions: [{ version_index: 1, evaluation: {}, outcomes: [], counts: { found: 2, partial: 0, missed: 0, wrong: 0 }, must_find: null, exact_must_find_keys: ["gap-a"], recovered_from_v0: ["gap-b"], lost_from_v0: [], recovered_from_previous: ["gap-b"], lost_from_previous: [], delta_from_v0: { found: 1, partial: 0, missed: -1, wrong: 0 }, delta_from_previous: { found: 1, partial: 0, missed: -1, wrong: 0 }, regressions: ["retained regression"], snapshot: null, critique: null, cumulative_metering: { cost_usd: 0, latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } }] }], totals: { distinct_exact_found_count: 2, distinct_exact_found_keys: ["gap-a", "gap-b"], distinct_exact_must_find_found_count: 1, distinct_exact_must_find_keys: ["gap-a"], summed_call_outcomes: { found: 2, partial: 0, missed: 0, wrong: 0 }, summed_call_must_find_outcomes: null, cost_usd: 0, latency_ms: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } }] } } }],
};

beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(workspaceId: string) { await act(async () => root.render(createElement(ExperimentResults, { workspaceId }))); }

it("renders source-gold scope, versions, per-call recovery, repeat members, unknown metering and exports", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(report)));
  await render("source-a");
  expect(host.textContent).toContain("Observed gain");
  expect(host.textContent).toContain("source-gold");
  expect(host.textContent).toContain("document-v1");
  expect(host.textContent).toContain("gold-v1");
  expect(host.textContent).toContain("pass-evaluator-v1");
  expect(host.textContent).toContain("gap-b");
  expect(host.textContent).toContain("retained regression");
  expect(host.textContent).toContain("must-find from previous: Unknown");
  expect(host.textContent).toContain("Unknown");
  expect(host.querySelector('a[href="#entry-pass%3Ap2%3A2"]')).not.toBeNull();
  expect(host.querySelector('a[download$=".json"]')?.getAttribute("href")).toBe("/api/accuracy/experiments/results?source_workspace_id=source-a&format=json");
  expect(host.querySelector('a[download$=".jsonl"]')?.getAttribute("href")).toBe("/api/accuracy/experiments/results?source_workspace_id=source-a&format=jsonl");
  expect(host.querySelectorAll("table caption").length).toBeGreaterThan(0);
});

it("renders standalone version deltas, item outcomes, runtime and unknown metering as descriptive evidence", async () => {
  const standalone = structuredClone(report);
  const entry = standalone.entries[0];
  entry.id = "experiment:alone";
  entry.kind = "standalone_attempt";
  entry.attribution.label = "Descriptive";
  entry.matched = false;
  entry.evidence.pass_comparison = undefined;
  const condition = structuredClone(report.entries[0].evidence.pass_comparison!.conditions[1]);
  condition.pass_count = null;
  condition.calls[0].runtime!.cost_usd = 0.25;
  condition.calls[0].runtime!.duration_ms = 73;
  condition.calls[0].runtime!.events = [{ event_type: "judgment", selected_iteration: 1, reason: "Improved", latency_ms: 1,
    cost_usd: 0.01, token_usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }];
  condition.calls[0].versions[0].outcomes = [{ outcome: "found", gold_item_key: "gap-a", model_item_index: 0, reason: "Exact match" }];
  condition.calls.push({ ...structuredClone(condition.calls[0]), call_id: "unknown-run", runtime: null });
  entry.evidence.standalone_condition = condition;
  vi.stubGlobal("fetch", vi.fn(async () => response(standalone)));

  await render("source-a");
  expect(host.textContent).toContain("Descriptive");
  expect(host.textContent).toContain("Standalone extraction details");
  expect(host.textContent).toContain("$0.2500");
  expect(host.textContent).toContain("73 ms");
  expect(host.textContent).toContain("Cost: Unknown");
  expect(host.textContent).toContain("gap-b");
  expect(host.textContent).toContain("Exact match");
  expect(host.textContent).toContain("judgment");
});

it("shows loading, empty, and failed states", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
  await render("source-a"); expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading");
  await act(async () => finish(response({ ...report, entries: [], repeat_series: [] })));
  expect(host.textContent).toContain("No retained experiments");
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "Unavailable" }, 503)));
  await render("source-b"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Unavailable");
});

it("names exact must-find keys recovered and lost between retained versions", async () => {
  const changed = structuredClone(report);
  const versions = changed.entries[0].evidence.pass_comparison!.conditions[1].calls[0].versions;
  versions.unshift({ ...versions[0], version_index: 0, exact_must_find_keys: ["gap-a", "gap-lost"] });
  versions[1].exact_must_find_keys = ["gap-a", "gap-b"];
  vi.stubGlobal("fetch", vi.fn(async () => response(changed)));
  await render("source-a");
  expect(host.textContent).toContain("must-find from previous: recovered gap-b; lost gap-lost");
});

it("shows all four outcome deltas for previous and V0 comparisons", async () => {
  const changed = structuredClone(report);
  const version = changed.entries[0].evidence.pass_comparison!.conditions[1].calls[0].versions[0];
  version.delta_from_previous = { found: 2, partial: 1, missed: -3, wrong: 1 };
  version.delta_from_v0 = { found: 3, partial: -1, missed: -2, wrong: 2 };
  vi.stubGlobal("fetch", vi.fn(async () => response(changed)));
  await render("source-a");
  const row = host.querySelector("table[aria-label='Per-call version outcomes'] tbody tr");
  expect(row?.textContent).toContain("Found +2, partial +1, missed -3, wrong +1");
  expect(row?.textContent).toContain("Found +3, partial -1, missed -2, wrong +2");
});

it("discards a late response from a previous workspace", async () => {
  let finishOld!: (value: ReturnType<typeof response>) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("source-a")
    ? new Promise(resolve => { finishOld = resolve; })
    : Promise.resolve(response({ ...report, source_workspace_id: "source-b", entries: [] }))));
  await render("source-a");
  await render("source-b");
  await act(async () => finishOld(response(report)));
  expect(host.textContent).toContain("No retained experiments");
  expect(host.textContent).not.toContain("Observed gain");
});

it("offers a workspace ID form without exposing an unscoped workspace list", async () => {
  const html = renderToStaticMarkup(await AccuracyExperimentsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("Source workspace ID");
  expect(html).toContain("/accuracy/experiments");
  expect(html).not.toContain("api/accuracy/workspaces");
});

it("keeps mixed full-pipeline status separate from scored source outcomes and shows lineage", async () => {
  const candidate = { status: "completed", attempt_id: "attempt-mixed", original_assembly: { fingerprint: "assembly-v1" }, setup: { configuration: { fingerprint: "config-v1" } },
    final_source_inventory: [{ claim_id: "gap-final" }], stages: [{ stage: "ideate", status: "completed", module_id: "ideate-module", module_version: "v3", usage: { estimated_cost: null, latency_ms: null } }],
    gates: [{ id: "gate-a", object_type: "proposal", decision: "pass", object_ids: ["proposal-a"], rationale: "validated" }],
    lineage: [{ kind: "selected", original_item_version_id: "original-v1", copied_claim_id: "copied-gap" }, { kind: "ideated", parent_claim_ids: ["copied-gap"], copied_claim_id: "proposal-a" }] };
  const mixed = { ...report, entries: [{ id: "mixed:m1", kind: "mixed_pair", created_at: "2026-10-06T11:00:00Z",
    attribution: { label: "Descriptive", scope: "source_gold", reasons: ["No complete labels for downstream stages."] }, matched: false,
    mismatch_reasons: ["Assembly fingerprint differs."], repeat_key: null, experiment_ids: ["attempt-mixed"], call_ids: [],
    evidence: { experiments: [], mixed_comparison: { status: "completed", header: { source_workspace_id: "source-a", request: { pack_id: "gold-a" }, pack_fingerprint: "gold-v1", evaluator_version: "source-evaluator-v1" }, attempts: { mixed: { id: "attempt-mixed" }, baseline: null },
      result: { evidence: { candidates: { mixed: candidate, baseline: null }, evaluation: { source_evaluations: [{ candidate: "mixed", point: "final", claim_type: "gap", evaluation: { status: "scored", score: { found: 1, partial: 0, missed: 0, wrong: 0 }, outcomes: [{ outcome: "found", gold_item_key: "gold-gap-a", model_item_index: 2, reason: "Exact source match" }, { outcome: "missed", gold_item_key: "gold-gap-b", reason: "No output item" }], errors: [] } }, { candidate: "mixed", point: "final", claim_type: "tactic", evaluation: { status: "gold_not_applicable", outcomes: [], errors: [] } }], applicability: [{ dimension: "source_gaps", status: "scored", reference_keys: ["gap-a"] }, { dimension: "plan", status: "unscored", reason: "No curated plan labels" }], changes: [{ dimension: "source_gaps", kind: "reference_lost", severity: "advisory", message: "Lost gap-b", item_ids: ["gap-b"] }] } } } } }
  }] } as unknown as ExperimentResultsReport;
  vi.stubGlobal("fetch", vi.fn(async () => response(mixed)));
  await render("source-a");
  expect(host.textContent).toContain("Full pipeline: completed");
  expect(host.textContent).toContain("No curated plan labels");
  expect(host.textContent).toContain("Lost gap-b");
  expect(host.textContent).toContain("original-v1 → copied-gap");
  expect(host.textContent).toContain("ideate-module v3 · Unknown · Unknown");
  expect(host.textContent).toContain("Full-pipeline improvement remains unscored");
  const outcomeTable = host.querySelector('table[aria-label="mixed final gap item outcomes"]');
  expect(outcomeTable?.textContent).toContain("gold-gap-a");
  expect(outcomeTable?.textContent).toContain("2");
  expect(outcomeTable?.textContent).toContain("Exact source match");
  expect(outcomeTable?.textContent).toContain("gold-gap-b");
  expect(outcomeTable?.textContent).toContain("No output item");
  expect(host.textContent).toContain("No item outcomes; gold not applicable");
});
