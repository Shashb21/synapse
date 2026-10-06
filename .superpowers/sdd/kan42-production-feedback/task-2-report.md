# Task 2: authenticated assembly feedback API

## Implemented

- Exact assembly `GET /api/accuracy/assemblies?workspace_id=...&assembly_id=...` now includes `feedback`, `feedback_runs`, and server-calculated `can_feedback` after signed-in workspace authorization. The workspace list response does not query or include these fields.
- `POST /api/accuracy/assemblies` accepts the strict `feedback` action. It requires a signed-in contributor with access to the workspace, then passes the exact assembly fingerprint, historical review, consumer run, optional item subset, category and rationale to `createAssemblyFeedback`.
- Subject, provider and actor are taken from `session.session`. Unknown or forged request fields fail strict Zod validation with HTTP 400. The route maps `AssemblyFeedbackError` codes to 400 (`invalid_input`), 404 (`not_found`) and 409 (`conflict`), returning `{ error, code }`.

## Exact request and response interface

```ts
type FeedbackPostRequest = {
  action: "feedback";
  workspace_id: string;
  assembly_id: string;
  expected_fingerprint: string;
  approval_review_id: string;
  consumer_run_id: string;
  selected_item_version_ids?: string[];
  category: "accepted_unchanged" | "edited" | "rejected" | "missing_item" | "split_merge" | "override";
  rationale: string;
};

type FeedbackPostSuccess = { ok: true; feedback: AssemblyFeedback }; // HTTP 200
type FeedbackErrorResponse = { error: string; code?: "invalid_input" | "not_found" | "conflict" };

type ExactAssemblyGetAdditions = {
  feedback: AssemblyFeedback[];
  feedback_runs: AssemblyFeedbackRun[];
  can_feedback: boolean;
};

type AssemblyFeedbackRun = {
  run_id: string;
  created_at: string;
  approval_review_id: string;
  consumed_item_version_ids: string[];
};

type AssemblyFeedback = {
  id: string;
  workspace_id: string;
  assembly_id: string;
  assembly_fingerprint: string;
  approval_review_id: string;
  consumer_run_id: string;
  selected_item_version_ids: string[];
  items: Array<{
    item_version_id: string;
    claim_type: "gap" | "tactic";
    source_file_id: string;
    evidence: Array<{ source_file_id: string; block_id: string; quote: string }>;
  }>;
  category: FeedbackPostRequest["category"];
  rationale: string;
  actor_subject: string;
  actor_provider: string;
  actor_name: string;
  actor_function: string;
  created_at: string;
};
```

`AssemblyFeedback` and `AssemblyFeedbackRun` are the Task 1 exported DTOs shown here. `can_feedback` is true for an authorized contributor, including when the assembly is superseded; it does not imply an eligible consumer run exists. Empty or omitted `selected_item_version_ids` means every item this exact assembly contributed to the selected consumer run. Existing exact-detail fields remain present. The list response remains `{ assemblies, revision_states }`.

## TDD and verification evidence

- RED: `npx vitest run tests/accuracy-assembly-api.test.ts --silent` (with local PostgreSQL access) exited 1: 5 feedback expectations failed because the old route omitted `feedback`, `feedback_runs`, and `can_feedback`, and routed `feedback` POST through the review schema (400 instead of expected 200/403 or domain error mapping). The initial sandboxed attempt could not connect to `127.0.0.1:5432` (`EPERM`), so the meaningful RED run used approved local database access.
- GREEN: `npx vitest run tests/accuracy-assembly-api.test.ts --silent` exited 0: 13/13 tests passed. The tests cover signed-out and role/tenant denial, exact-detail and lightweight-list behavior, forged identity/unknown fields, session-derived identity, successful route write, and invalid consumer/subset error mapping. The invalid consumer path invokes the real store; the subset mapping uses a typed store error because exact historical proof is covered by Task 1 store tests.
- `npm run typecheck` exited 0 (`next typegen && tsc --noEmit`).
- `npx eslint src/app/api/accuracy/assemblies/route.ts tests/accuracy-assembly-api.test.ts` exited 0 with no diagnostics.
- `git diff --check` exited 0.

## Files and self-review

- `src/app/api/accuracy/assemblies/route.ts`
- `tests/accuracy-assembly-api.test.ts`
- `.superpowers/sdd/kan42-production-feedback/task-2-report.md`

Self-review found the existing API fixture lacked declared extraction lineage, which made Task 1's defensive history reader reject even an empty history. I added the fixture's production extraction run declaration and reran the focused test. The route modifies no assembly, review, evaluation or gold metric. It uses the immutable assembly ID and fingerprint rather than a moving head.

Concern: `listAssemblyFeedback` validates item lineage before reading history, including when an older assembly has no feedback. An existing persisted assembly with incomplete legacy extraction metadata may cause exact-detail GET to return HTTP 400. This behavior is in Task 1's store, outside Task 2 ownership; the controller has been notified.
