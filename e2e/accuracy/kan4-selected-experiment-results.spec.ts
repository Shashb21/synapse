/** Browser consumer coverage over retained fixture evidence; no live model accuracy claim. */
import { expect, test } from "@playwright/test";
import type { ExperimentResultsReport } from "../../src/accuracy/experiments/results-report";
import type { ComparedCondition } from "../../src/accuracy/eval/pass-comparison";

function reportFixture(): ExperimentResultsReport {
  const counts = { found: 2, partial: 0, missed: 0, wrong: 0 };
  const metering = { cost_usd: 10, latency_ms: 20, token_usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
  const condition: ComparedCondition = { experiment_id: "earlier-selection", pass_count: 3, status: "completed", identity: {},
    eligibility: "ineligible", reasons: ["Serious source-support finding retained in V3."],
    totals: { ...metering, summed_call_outcomes: counts, summed_call_must_find_outcomes: counts,
      distinct_exact_found_count: 2, distinct_exact_found_keys: ["need_extract:a", "need_extract:b"],
      distinct_exact_must_find_found_count: 2, distinct_exact_must_find_keys: ["need_extract:a", "need_extract:b"] },
    calls: [{ call_id: "chosen-call", call_kind: "need_extract", lineage_key: "need_extract:source:0",
      requested_revision_passes: 3, terminal_iteration: 3, selected_iteration: 1, quality_basis: "selected_raw_snapshot",
      full_call_metering: metering, runtime: { call_id: "chosen-call", module_id: "fixture", module_version: "v1", route: {},
        status: "ok", duration_ms: 20, cost_usd: 10, token_usage: metering.token_usage,
        execution_identity: { status: "available", identities: [{ schema_version: "execution-identity-v1", status: "available",
          git_commit: "retained-commit", worktree: "dirty", source_fingerprint: "exact-local-source", prompt_sources_fingerprint: "prompt-templates",
          build_id: null, deployment_id: null }], completions: [{ completion_id: "completion-1", purpose: "extract:r0",
          system_fingerprint: "system-hash", user_fingerprint: "user-hash", provider_id: "fixture", configured_model: "configured-model",
          temperature: 0, max_tokens: 200, response_model: null, provider_revision: null, status: "succeeded" }] },
        events: [{ event_type: "judgment", selected_iteration: 1, reason: "Source-backed V1", latency_ms: 1,
          cost_usd: 0, token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }] },
      versions: [0, 1, 2, 3].map(version_index => ({ version_index, evaluation: { status: "scored" },
        outcomes: [{ outcome: "found", gold_item_key: "a", reason: `Retained V${version_index} source match` }],
        counts: version_index === 1 ? counts : { ...counts, found: 1, missed: 1 }, must_find: counts,
        exact_must_find_keys: version_index === 1 ? ["a", "b"] : ["a"],
        recovered_from_v0: version_index === 1 ? ["b"] : [], lost_from_v0: [],
        recovered_from_previous: [], lost_from_previous: [], delta_from_v0: { found: 0, partial: 0, missed: 0, wrong: 0 },
        delta_from_previous: { found: 0, partial: 0, missed: 0, wrong: 0 },
        regressions: version_index === 3 ? ["New serious critic finding: terminal-false"] : [],
        snapshot: null, critique: null, cumulative_metering: metering })) }],
  };
  return { schema_version: "experiment-results-v1", source_workspace_id: "kan4-retained-fixture", repeat_series: [],
    entries: [{ id: "pass:kan4:3", kind: "pass_candidate", created_at: "2026-10-09", matched: false,
      attribution: { label: "Descriptive", scope: "source_gold", reasons: ["Scripted retained evidence; accuracy is unproven."] },
      mismatch_reasons: [], repeat_key: null, experiment_ids: ["earlier-selection"], call_ids: ["chosen-call"],
      evidence: { experiments: [], pass_comparison: { comparison_evaluator_version: "pass-comparison-v2", comparison_id: "kan4",
        matched: false, mismatch_reasons: [], conditions: [condition], recommendation: null, loaded_pack_identity: null } } }] };
}

test("shows V1 quality separately from produced V3 and preserves serious later evidence in JSONL", async ({ page }) => {
  const report = reportFixture();
  await page.route("**/api/accuracy/experiments/results?**", async route => {
    const format = new URL(route.request().url()).searchParams.get("format");
    const body = format === "jsonl" ? JSON.stringify({ schema_version: report.schema_version,
      source_workspace_id: report.source_workspace_id, entry: report.entries[0], repeat_series: [] }) + "\n" : JSON.stringify(report);
    await route.fulfill({ status: 200, contentType: format === "jsonl" ? "application/x-ndjson" : "application/json", body });
  });
  await page.goto("/admin/accuracy/experiments?workspace_id=kan4-retained-fixture");
  await expect(page.getByRole("heading", { name: "Experiment results", exact: true })).toBeVisible();
  await page.getByText("3 pass · need_extract · chosen-call", { exact: true }).click();
  await expect(page.getByText("Requested revisions: 3 · Terminal: V3 · Selected: V1", { exact: true })).toBeVisible();
  await expect(page.getByText("Quality: selected raw snapshot · Usage: entire run", { exact: true })).toBeVisible();
  const table = page.getByRole("table", { name: "Per-call version outcomes" });
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row", { name: /^V1 / })).toContainText("2 / 0 / 0 / 0");
  await expect(table.getByRole("row", { name: /^V3 / })).toContainText("New serious critic finding: terminal-false");
  await expect(page.getByRole("cell", { name: "completed · ineligible", exact: true })).toBeVisible();
  const exactEvidence = page.getByText("Exact critic, judge, route and version evidence", { exact: true });
  await exactEvidence.click();
  await expect(exactEvidence.locator("..").locator("pre")).toContainText('"source_fingerprint": "exact-local-source"');
  await expect(exactEvidence.locator("..").locator("pre")).toContainText('"user_fingerprint": "user-hash"');
  const exportLink = page.getByRole("link", { name: "Download full JSONL" });
  await expect(exportLink).toHaveAttribute("href", "/api/accuracy/experiments/results?source_workspace_id=kan4-retained-fixture&format=jsonl");
  // Fetch the rendered export link in the browser; the fixture intercepts this request.
  const jsonl = await exportLink.evaluate(async link => (await fetch((link as HTMLAnchorElement).href)).text());
  const exported = JSON.parse(jsonl.trim());
  const comparison = exported.entry.evidence.pass_comparison;
  expect(comparison.comparison_evaluator_version).toBe("pass-comparison-v2");
  expect(comparison.conditions[0].calls[0]).toMatchObject({ selected_iteration: 1, terminal_iteration: 3, requested_revision_passes: 3 });
  expect(comparison.conditions[0].calls[0].versions).toHaveLength(4);
  expect(comparison.conditions[0].totals).toMatchObject({ distinct_exact_found_count: 2, cost_usd: 10, latency_ms: 20 });
  expect(comparison.recommendation).toBeNull();
  expect(comparison.conditions[0].calls[0].runtime.execution_identity).toMatchObject({
    identities: [{ worktree: "dirty", source_fingerprint: "exact-local-source" }],
    completions: [{ purpose: "extract:r0", provider_revision: null, user_fingerprint: "user-hash" }] });
});
