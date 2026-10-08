# Paired mixed pipeline benchmark (KAN-40)

This authenticated API replays two explicitly nominated saved assemblies in separate private workspaces. It uses existing extracted versions and never reruns extraction. The source workspace and its live approval boundary stay separate from the benchmark copies. Running a benchmark does not approve an assembly, validate live claims or promote a candidate to production.

POST `/api/accuracy/experiments/mixed-comparisons` with a session that has validation capability and access to the original source workspace:

```json
{
  "source_workspace_id": "original-workspace-id",
  "source_file_ids": ["original-source-file-id"],
  "pack_id": "beone-bgb-58067-prmt5i",
  "mixed": {
    "assembly_id": "nominated-mixed-assembly-id",
    "fingerprint": "exact-saved-mixed-fingerprint"
  },
  "baseline": {
    "assembly_id": "nominated-baseline-assembly-id",
    "fingerprint": "exact-saved-baseline-fingerprint"
  }
}
```

Replace the example identifiers with saved source and assembly identities. Both nominations and their exact fingerprints are mandatory, including the baseline; the server never chooses a “latest” assembly. Both must belong to the selected original source scope and contain model-origin versions. Duplicate source IDs, unknown fields and nested overrides are rejected. Actor identity comes from the server session. Clients cannot supply gold answers, copied workspace IDs, comparison IDs, configuration overrides, trusted scope flags or gate settings.

The response is HTTP 201 with `{ "comparison": { ... } }`. It records a fresh comparison and attempts on every explicit rerun. Check `comparison.status` and `comparison.result.evidence`: 201 means a retained record was created, and a `blocked` or `failed` record remains blocked or failed. It does not establish a successful pipeline. Both copies must pass matched setup checks before either candidate executes.

GET `/api/accuracy/experiments/mixed-comparisons?source_workspace_id=original-workspace-id&comparison_id=retained-comparison-id&format=json` exports one complete comparison object. Omit `format` for JSON, or use `format=jsonl` for one complete JSON object followed by a newline. JSONL uses `application/x-ndjson`; JSON uses `application/json`. Responses use `Cache-Control: private, no-store`. Unknown or repeated query parameters, blank identifiers and other formats return a typed 400 error.

An authorized viewer may export retained evidence. Authorization always uses the original source workspace; possession of a comparison or private copy UUID does not grant access. Signed-out requests return 401, POST without validation capability returns 403, and inaccessible source scopes or absent comparisons return 404 without disclosing another workspace's records. Known input/identity validation errors return 400 with a safe message and typed `code`. Unexpected execution or storage errors return a generic 500.

Exports include the immutable original assemblies and request, matched source/pack/evaluator/configuration identities, separate copy maps, linked attempt calls and evaluations, selected and generated lineage, automatic gate decisions, every retained stage outcome, final outputs and evaluator applicability. Empty outputs, skipped branches and blockers remain present. Reading does not reconstruct artifacts from current live claims, parse blocks, coverage or plan state. The gate is fixed to `deterministic_checks_pass_no_edits_v1`: blocking deterministic findings stop progression, advisory findings remain recorded, and successful gates preserve the exact content without human edits.

Source gap and inventory tactic dimensions have curated gold and are scored at entry and final inventory. Provenance and downstream coverage, status, residual, priority, ideation and plan dimensions have no curated correctness labels in the supported pack. They remain explicitly unscored. Their output changes and deterministic invariant findings are useful diagnostics, but are not an overall pipeline accuracy score or an automatic promotion recommendation. Gold answers remain confined to evaluator code.

Partial splitting generates two draft children from the actual copied parent, validated partial/limited coverage, committed tactic payloads and copied source blocks. Both children retain parent/run lineage, rationale, tactic/coverage bindings and unchanged source-context spans. These quotations support the original parent's context; they do not claim that generated child statements appear verbatim in the source. The deterministic gate rejects parent copies, duplicate or crossed child identities, unsupported context or uncommitted support before both children and context records are materialized atomically in the experiment. Generation has no fabricated residual fallback; unavailable or malformed provider output remains a visible failure or blocker. Production splitting proposes drafts only. Proposed-only partial coverage cannot justify an addressed child and remains a visible unsupported-support failure.

The original parent and its partial status remain in historical evidence and source scoring. Operational prioritization excludes split parents and uses the addressed child and open remainder as applicable. The addressed child has explicit coverage derived from the supported slice, bound to the split gate and original coverage evidence. This is a generated proposal supported by deterministic binding checks; its semantic quality remains unscored without curated labels.

Priority suggestions use the existing S8 default weighted axes, cue heuristic and band thresholds. Connected providers must return every exact eligible gap and every configured finite 0–100 axis score with rationale; local test/no-route execution records its deterministic mode. The fixed axes, scoring identity, prompt identity and full scoring evidence are retained for both matched candidates. Durable priority bands remain scalar workflow overlays, with full suggestion evidence in `priority_scoring`; production suggestions retain scoring evidence without replacing an accepted workflow band. Effective scalar placements are persisted in experiment scope after the fixed gate policy; these suggestions do not approve an assembly or validate live claims.

Generated children reach status, priority and ideation as applicable. Selected and generated validated tactics and gaps feed Gantt projection; proposed tactics without source dates produce no invented bars. Final source inventory remains the original exact selected payloads, while generated payloads remain separately in lineage. Empty branches remain explicitly skipped. The deterministic checker and downstream evaluator are versioned as `mixed-deterministic-checks-v2` and `mixed-downstream-v2`.

Real Postgres/kernel tests complete paired nonempty open and partial branches using a controlled completion adapter. Those fixtures prove orchestration, retained calls/evaluations, generated lineage, no-edit gates and JSON/JSONL export integrity; they do not establish live-provider benchmark accuracy. KAN-41 owns the later UI; this change exposes the API and exports only.
