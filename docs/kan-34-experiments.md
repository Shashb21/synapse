# KAN-34 isolated gold experiments

## Purpose and boundary

An isolated gold experiment tests an accuracy module or the current extraction
workflow against a curated reference pack without changing the source knowledge
base. Each request creates a new experiment and a separate copied workspace.
All copied drafts, module runs, agent events, extraction batches, and recovery
records belong to that copy. The source workspace remains the lineage and access
scope used to read the retained results.

The curated gold files are available only to the experiment evaluator. They are
never request fields, copied-workspace data, module inputs, prompts, production
event payloads, or production scores. Production continues to expose source
support, structural checks, omission risks, human actions, cost, and latency;
it does not expose gold precision, recall, or F1.

## Start a local experiment

Sign in as a contributor (or another role with the `validate` capability) who
has been granted access to the source workspace's organization. Send a `POST`
to `/api/accuracy/experiments`. The server derives the actor and organization
from the signed-in session. Do not send an actor, organization ID, gold rows, or
an experiment-copy workspace ID.

This is the smallest useful single-call request. Replace the placeholder IDs
with a source workspace, a source file in that workspace, and parse-block IDs
from that same source file.

```bash
curl --cookie "<session-cookie>" \
  --header "content-type: application/json" \
  --request POST http://localhost:3000/api/accuracy/experiments \
  --data '{
    "mode": "single_call",
    "source_workspace_id": "ws_source",
    "source_file_ids": ["src_source"],
    "pack_id": "beone-bgb-58067-prmt5i",
    "condition": {
      "label": "baseline",
      "model": "configured-model",
      "temperature": 0,
      "prompt_version": "need-extract.agent-v1"
    },
    "call": {
      "call_kind": "need_extract",
      "input": {
        "workspace_id": "ws_source",
        "source_file_id": "src_source",
        "block_ids": ["block_1"]
      }
    }
  }'
```

The request schema is strict. For `single_call`, `call` is required and must
conform exactly to the active module's public input schema. For `pipeline`,
omit `call`; it runs `inventory_extract`, `need_extract`, `merge_dedupe`, and
`status_derive` for every selected source file in caller order. The runner
remaps recognized source, block, claim, workspace, and organization references
to the copy and rejects references that cannot be remapped.

`condition` records the tested setup. It may contain only `label`, `model`,
`temperature` (0 through 2), `max_tokens`, and `prompt_version`. Record the
actual model and prompt version when those variables matter; an empty object is
valid but makes later interpretation weaker.

The response is `201` and contains the new experiment record. Repeating the
identical request deliberately produces a distinct experiment, copied
workspace, module runs, calls, and evaluations. Experiments are append-only
apart from their terminal `completed` or `failed` status, so a repeat is never
an overwrite.

## Read and export results

Reads are scoped by the original source workspace, not the private copied
workspace. Any signed-in role with a grant to that organization may read and
export. Use the experiment ID returned by the start response:

```bash
curl --cookie "<session-cookie>" \
  "http://localhost:3000/api/accuracy/experiments/experiment_123?source_workspace_id=ws_source"
```

The record includes the source and baseline fingerprints, baseline snapshot,
pack fingerprint, evaluator version, condition, retained call inputs and
outputs/errors, module version and route, and item-level evaluations.

Export every experiment for the same source workspace as a deterministic JSON
array:

```bash
curl --cookie "<session-cookie>" \
  "http://localhost:3000/api/accuracy/experiments?source_workspace_id=ws_source&format=json" \
  --output experiments.json
```

For streaming or analysis tools, request JSONL instead. The export has one
complete experiment record per newline, with a final newline:

```bash
curl --cookie "<session-cookie>" \
  "http://localhost:3000/api/accuracy/experiments?source_workspace_id=ws_source&format=jsonl" \
  --output experiments.jsonl
```

## Evaluator-v1 contract

`experiment-evaluator-v1` scores only `need_extract` and
`inventory_extract`. It validates the expected item array (`gaps` or
`tactics`) first. For `need_extract`, a gap needs a non-empty `statement` and
an optional string `external_id`. For `inventory_extract`, a tactic needs a
non-empty `name` and string `id`. Invalid shapes receive `invalid_output`;
model failures receive `model_error` with their retained error. Other call
kinds retain their output shape and receive `gold_not_applicable`, without an
invented score.

The evaluator performs deterministic, one-to-one matching against unused gold
items in this order:

1. Match a stable external ID, if present.
2. Otherwise match exact normalized text. Normalization lowercases text,
   removes non-alphanumeric punctuation, and collapses whitespace.
3. Otherwise match when the unique-word-set overlap is at least **0.60**.

An exact normalized text match is `found`. A stable-ID match with different
text, or a word-set match at the 0.60 threshold, is `partial`. An unmatched
gold item is `missed`; an unmatched model item is `wrong`. One model item can
match at most one gold item and vice versa.

Only `found` outcomes contribute to exact precision, recall, and F1. Partials
remain visible in the item outcomes but receive no exact-score credit. Exact
precision is `found / (found + wrong)` (or zero when that denominator is zero),
and exact recall is `found / total gold items`; F1 is their harmonic mean.
This conservative evaluator is intentionally versioned: changing matching
rules requires a new evaluator version, rather than rewriting prior results.

## Compare repeats

Use the retained identities to decide whether two records are comparable:

| Identity | Must match for an attributed comparison |
| --- | --- |
| `source_fingerprint` | Yes: the selected source document set is identical. |
| `baseline_fingerprint` | Yes: copied baseline claims, provenance, blocks, and coverage state are identical. |
| `pack_id` and `pack_fingerprint` | Yes: the same curated reference-pack content is used. |
| `evaluator_version` | Yes: the same matching and scoring rules are used. |
| `condition` | Yes, except for the explicitly tested variable. Record that variable in the condition. |

Matching fingerprints permit an **observed gain** for a pair. Several
separately retained repeats with the same setup are needed before calling an
improvement consistent. If any identity differs, retain and show the records
side by side only; do not attribute the score difference to the prompt, model,
or another condition.

Decision: evaluator-v1 uses deterministic, conservative matching and exact
metrics exclude partial matches. Cost if this proves too strict: legitimate
paraphrases can remain partial or missed until a separately reviewed evaluator
version changes the policy; it must not alter retained v1 comparisons.

## Access grants and pipeline recovery

New workspaces grant their authenticated creator access to the new organization.
For an existing organization, an authenticated operator provisions a subject
with:

```bash
curl --cookie "<operator-session-cookie>" \
  --header "content-type: application/json" \
  --request POST http://localhost:3000/api/accuracy/organizations/org_123/grants \
  --data '{"subject":"identity-provider-subject"}'
```

The route requires `manage_organization_access`, validates the subject, and
returns `404` without creating a grant if the organization does not exist.
Before requesting an experiment, provision the user who will start, read, or
export it. A missing grant appears as an inaccessible source workspace.

Pipeline experiments use the same extraction batch and pause/resume journal as
normal extraction. After extraction drafts are applied in the copied workspace,
the journal reserves durable merge and status run IDs. An important omission
pauses progression while preserving the completed stage effects and journal
state, so the copied batch is resumable. A non-pause downstream failure rolls
back that downstream transaction; the experiment retains its failure evidence
and ends `failed`. Neither pause nor failure writes claims, runs, events, or
recovery state into the source workspace.

🚩 A copied workspace is implementation state, not an API scope. Keep its ID
out of scripts and dashboards that read results; always supply the original
`source_workspace_id` so authorization and experiment lineage stay aligned.
