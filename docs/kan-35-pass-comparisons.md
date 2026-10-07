# Controlled extraction pass comparisons (KAN-35)

A **pass** is one critic feedback/revision exchange. A **cohort** is a set of three independent experiment attempts with one, two, and three passes, each in a separate copied workspace. This API tests extraction depth without changing the original source workspace or production settings. Repeating a request creates a new cohort and three new attempts.

## Start a cohort

Use an authenticated application session with validation capability (`medical_affairs`, `contributor`, or `operator`) and access to the original source workspace. Readers with workspace access may inspect results but cannot start experiments. Actor identity comes from the session.

`POST /api/accuracy/experiments/pass-comparisons`

```json
{
  "mode": "single_call",
  "source_workspace_id": "ws-source",
  "source_file_ids": ["src-source"],
  "pack_id": "beone-bgb-58067-prmt5i",
  "condition": { "label": "Extraction depth comparison" },
  "call": {
    "call_kind": "need_extract",
    "input": {
      "workspace_id": "ws-source",
      "source_file_id": "src-source"
    }
  }
}
```

Use your retained workspace/source IDs. Controlled single calls support `need_extract` and `inventory_extract` only. The active module's input schema validates and normalizes `call.input`; unknown keys, including nested keys stripped by its schema, are rejected. All selected source files must belong to the original workspace. For comparison requests, `source_file_ids` must also be distinct after surrounding whitespace is trimmed; duplicates receive HTTP 400 before the runner or copy service starts. Source-owned input identifiers are remapped into the copy by the experiment runner. Gold answers never enter module inputs.

For comparison requests, `call.input.workspace_id` must equal `source_workspace_id`, and `call.input.source_file_id` must name one of the selected original `source_file_ids`. Every explicit `block_ids` entry must belong to that same original source file in the original workspace, even when multiple source files are selected. Copied, foreign, missing, unselected, and cross-source identifiers receive the same safe HTTP 400 error before the runner creates any copies. An empty block list keeps the extractor's whole-source behavior; omission is allowed only when the active module's schema supplies or permits it. This stricter comparison check does not change the existing single-experiment endpoint's legacy input remapping.

For the current extraction pipeline, set `mode` to `pipeline` and omit `call`; keep the other fields. The pipeline runs both extractors for each selected source and retains repeated downstream `merge_dedupe` and `status_derive` calls and their runtime costs.

The server generates the comparison ID and the 1/2/3 controls. Do not send actor, organization, copied workspace, gold rows, or execution controls. Reserved condition keys are `comparison_id`, `comparison_evaluator_version`, `original_request_identity`, `original_request_fingerprint`, `critic_revision_passes`, and `experiment_cycle_control`. Top-level unknown keys are also rejected.

Condition `label`, `model`, `temperature`, `max_tokens`, and `prompt_version` describe the experiment request. They do **not** change the active module, provider/model routing, or execution parameters. Inspect each condition's retained actual module and route identity to determine what ran.

A successful request returns HTTP 201:

```json
{
  "comparison_id": "comparison-generated",
  "experiments": ["three complete retained experiment records"],
  "comparison": { "comparison_evaluator_version": "pass-comparison-v1" }
}
```

The example abbreviates the large records; `experiments` contains objects, not strings. HTTP 201 means attempts were retained, so inspect experiment `status`, condition `eligibility`, and `reasons`: failed or incomplete attempts may be returned for diagnosis. The API does not delete failure evidence or promote a result to production.

## Read a retained comparison

`GET /api/accuracy/experiments/pass-comparisons?source_workspace_id=ws-source&experiment_id=experiment-one&experiment_id=experiment-two&experiment_id=experiment-three`

Supply exactly one nonempty `source_workspace_id` and one to three distinct, nonempty repeated `experiment_id` parameters. The response is HTTP 200 with `{ "comparison": ... }`. Every ID is checked against the original authorized source workspace before retained evidence is loaded. Absent IDs and IDs from another workspace return the same HTTP 404 response. Workspace access uses the existing organization grants; an operator retains the existing wider inspection capability.

For a partial cohort:

`GET /api/accuracy/experiments/pass-comparisons?source_workspace_id=ws-source&experiment_id=experiment-one`

One or two attempts remain inspectable, but the comparison is descriptive: `matched` is false, `mismatch_reasons` explains the missing conditions, and `recommendation` is null. Duplicate IDs and more than three IDs return HTTP 400.

Both methods require sign-in (HTTP 401); POST also requires validation capability (HTTP 403). Invalid request/input/pack/source ownership returns HTTP 400. Unauthorized or nonexistent source workspaces return HTTP 404 without distinguishing them. Unexpected server faults return a generic HTTP 500 response; internal error details are logged server-side.

## Versions and assessment evidence

An N-pass completed extraction retains V0 (initial proposal) through VN (final revision): two, three, or four snapshots for one, two, or three passes. Controlled experiments disable the clean-critique early exit. The terminal critic assessment checks VN and the judgment records the final decision; those assessments do not create an extra revision pass. Production early exit and depth are unchanged.

Each retained call/version reports `found`, `partial`, `missed`, and `wrong` gold outcomes; exact must-find keys and their recovery/loss relative to V0 and the preceding version; quote/invariant/critic/completeness evidence; and token, cost, and latency measurements. **Must-find** means a reference target explicitly marked as required. A partial match is useful descriptive evidence but never an exact recovery. A gold nonmatch alone does not establish that a claim is false or unsupported by its source.

Per-version `cumulative_metering` includes proposal generation and assessments through that version. `full_call_metering` uses the complete persisted runtime, including terminal assessment and judgment. Condition metering sums every distinct runtime, including downstream pipeline calls. Missing runtime measurements remain visible in the evidence and prevent eligibility; descriptive aggregate zeros do not imply known zero cost.

Condition totals distinguish two different questions:

| Field | Meaning |
| --- | --- |
| `summed_call_outcomes` | Final gold outcome counts summed across retained calls. |
| `summed_call_must_find_outcomes` | Final must-find outcome counts summed across calls, or null when target identity is unavailable. |
| `distinct_exact_found_count`, `distinct_exact_found_keys` | Distinct exact gold targets across selected sources, qualified by extractor kind. |
| `distinct_exact_must_find_found_count`, `distinct_exact_must_find_keys` | Distinct exact must-find targets used for the first ranking criterion, or null when target identity is unavailable. |

For example, recovering `need_extract:a` in two documents counts once for ranking. Recovering `need_extract:a` and `need_extract:b` counts twice. An inventory target with the same raw key remains a separate target, such as `inventory_extract:a`. Per-call sums remain available to describe duplicate source coverage.

## Identity, drift, and recommendation limits

Attributed comparison requires matching original source workspace, source/baseline fingerprints, pack ID/fingerprint, evaluator versions, complete original request identity/fingerprint, original source lineage, and actual runtime module ID/version/route. A **fingerprint** is a hash of the relevant retained content: different hashes show that the compared inputs or configuration differ. Copied IDs do not substitute for original lineage. Mixed cohorts or identity differences produce mismatch reasons and no recommendation.

GET recomputes results from retained experiment records and append-only agent events. `loaded_pack_identity` records the currently loaded pack ID, its fingerprint (which can be null), and whether it matches retained identity. If the gold files have changed, disappeared, become unreadable/malformed, or changed during target loading, the historical must-find identity cannot be validated. `matched` becomes false and `recommendation` is null. Target-based fields (`must_find`, exact must-find keys, recoveries/losses, summed must-find outcomes, and distinct must-find metrics) become null, rather than misleading zeroes. Historical stored outcomes, snapshots, evaluation records, and ordinary exact gold counts remain inspectable.

Failed/incomplete attempts, invalid output, invalid quotes, failing invariants, and serious high/critical source-support findings are ineligible, including problems already present at V0. Explicit false/unsupported/provenance findings retain their evidence and source references. Important omissions remain visible completeness risks rather than false-claim findings. Missing assessments, unchecked quotes, missing runtime evidence, or failed/incomplete completeness checks produce unknown eligibility and cannot win.

Only eligible conditions in a complete matched cohort can be recommended. Ranking is lexicographic (the first differing criterion decides): more distinct exact must-find targets, then more distinct exact gold targets, fewer summed wrong outcomes, fewer summed partial outcomes, lower full runtime cost, lower full runtime latency, and finally fewer passes. Quality therefore outranks cost. A recommendation is an experiment result, never deployment approval or a change to production settings. Local controlled tests establish implementation behavior; claims about model quality require separately executed benchmark experiments.

## Existing experiments and raw exports

The existing `POST /api/accuracy/experiments` still returns `{ "experiment": ... }`. Its condition may optionally contain integer `critic_revision_passes` of 1, 2, or 3 for an extraction single call or the extraction pipeline. Omitting the field preserves existing default depth and early-exit behavior. Other controlled single-call kinds and invalid pass counts are rejected before copying.

Existing exports include complete raw records, inputs, outputs, evaluations, and actual route identities:

```text
GET /api/accuracy/experiments?source_workspace_id=ws-source&format=json
GET /api/accuracy/experiments?source_workspace_id=ws-source&format=jsonl
GET /api/accuracy/experiments/experiment-one?source_workspace_id=ws-source
```

JSON returns an array; JSONL (`application/x-ndjson`) returns one experiment record per line. These exports use the same existing source-workspace authorization and can be retained alongside the versioned derived comparison. No UI or production promotion is included in KAN-35.

## Verify behavior locally

Use the configured local `synapse_test` database and the test-only local proposer setting supplied by Vitest:

```sh
npx vitest run tests/accuracy-pass-comparison-api.test.ts tests/accuracy-experiment-api.test.ts tests/accuracy-experiment-api-integration.test.ts --silent
npx vitest run tests/accuracy-pass-comparison.test.ts tests/accuracy-pass-comparison-run.test.ts --silent
```

The API integrations exercise real organization grants, input normalization, independent copies, exact version counts, reader scoping, uniform cross-workspace not-found responses, and retained failures without paid model calls. Evaluation tests cover exact target recovery, distinct ranking, gold drift, and conservative safety eligibility.
