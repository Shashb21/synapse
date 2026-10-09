# Traceability: who changed what, and what the AI was asked

This page covers how Synapse records plan changes (KAN-90) and model calls (KAN-91). The platform audit log itself is described with KAN-87: it is append-only and the database refuses updates and deletes.

## Plan changes (KAN-90)

Every plan change is recorded in the workspace, and a copy goes to the platform audit log.

- **Edit records** (`edit_records`) hold field-level changes with their before and after values. Each row carries:
  - `actor_principal`: the account id or email of the signed-in person;
  - `actor_role`;
  - `request_id`: the proxy's `x-request-id`;
  - the request's real `workspace_id`.
- **Rationale.** It is null when the person gave none: a gate action without a reason is still recorded.
- **Workspace audit rows** (`audit`) hold plan actions (lock, create, merge, and so on). They carry the same attribution columns.
- **The platform copy.** Each edit record and each workspace audit row is copied to `audit_events` (category `plan`), in the same transaction as the change. `meta.source` says which kind of row it copies: `edit_record` or `plan_audit`. One request id ties a change, its records and its platform copy together.
- **Refused attempts** are logged with `meta.outcome = "denied"` and the reason:
  - a signed-in person refused by an owner-only API;
  - a signed-in person refused by a workspace permission (403);
  - a non-owner trying to replace a workspace's contents;
  - a refused owner-console user action.

  Signed-out traffic is not logged.
- **Learning provenance.** `hillclimb_signals` keep the actor's principal and name, and the run that produced them (`source_run_id`). `decision_examples` keep the principal and name; their `run_id` is the source run. A decision example that cannot be written is logged in `audit_events` (category `ai`, `meta.outcome = "failed"`) instead of being dropped.
- **History.** The gap and tactic pages show a **History** section, newest first. Each entry gives who, their role, when, before → after, and the rationale. A workspace audit row from the same request as an edit record is folded into that edit record.

## Model calls (KAN-91)

Every model call is stored whole in the platform table `llm_calls`. This covers stage runs (`completionFor`) and accuracy runs. Each row holds:

- `run_id`, `stage`, `step`, `purpose` and `attempt`;
- the provider, model and parameters;
- the system prompt, user prompt and reply, untruncated;
- the provider's token usage:
  - Anthropic `usage`, including cached prompt tokens;
  - OpenAI, OpenRouter and xAI `usage`;
  - Gemini `usageMetadata`, where thinking tokens count as output;
- an estimated cost from `src/accuracy/kernel/cost.ts`. It is null when the model's price is unknown;
- the latency;
- the status, and the error when the call failed.

The run's trace step names its call by `llm_call_id`.

**Secrets.** Before storage, every configured provider key and anything key-shaped is removed from the prompts and the reply. The removed patterns are `sk-…`, `xai-…`, `AIza…`, bearer tokens, and `password`/`api_key`/`secret`/`token` values.

**Where to see it.** These views are owner only:

- The run page (`/admin/runs/<id>`) shows each call with collapsible prompts and reply, its tokens and cost, and the run's totals.
- The Runs page shows model tokens and estimated cost per stage.
- `GET /api/runs/<id>` returns `llm_calls` and `llm_totals`.

## Upload retention (KAN-91)

An upload's bytes are stored once, in the workspace's `source_files` table, and S1 parses them from there.

The S0 run's trace and input keep no file content. For each file they record:

- its `sha256`;
- its size in bytes;
- its filename, title and type;
- the id of the stored file (`stored_file_id`, which is the same as `source_files.id`).

Run traces are kept as long as the workspace. A workspace reset leaves `module_runs`, `llm_calls` and the audit logs in place; it removes `source_files`.
