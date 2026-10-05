# KAN-39 Task 1 backend report

## Round 1 correction — F1 current ownership agreement (2026-10-03)

**F1 corrected and focused verification passed.** Only `src/accuracy/store/assembly-review-store.ts` and `tests/accuracy-assembly-revision.test.ts` changed in this round. No frontend edits, commits, pushes, Jira writes, or subagents. Editing has stopped. Controller owns fresh review and final integrated full-suite verification.

### Reproduction and root cause

Read F1 verbatim from `/private/tmp/kan39-backend-review.md`, then traced review-current checks, current head resolution, projection, and downstream consumption/publication. Before the fix, two real PostgreSQL integration scenarios reproduced the same defect: tactic-only baseline → approved human gap → approved independent need-only owner, and gap-only baseline → approved human tactic → approved independent inventory-only owner. Independent extraction payloads have distinct canonical identities. Review already reported the human revision stale, while both live readers returned a mixed projection. A `status_derive` module started after ownership changed consumed the stale revision binding, saved an `ok` run, and persisted `computed_status`. Thus the regression covers work begun after the change, in addition to the existing in-flight publication race.

The root cause was ownership validation after filtering opposite-kind human items out of the live projection. That branch could never detect the new counterpart owner. `assemblyForHead` now applies the existing `assemblyCurrentForDeclaredProductionRuns` rule to every human revision before projection and rejects stale ownership using `approval_required`. Publication binding revalidation translates this refusal to the established `conflict`. Removed the unreachable counterpart check. Generated assembly heads still use their deliberate per-kind projection; legacy unmanaged workspaces still return null.

### Regression guarantees

The two new parameterized cases first verify that the approved human item reaches live inventory and downstream claims. After approving the independent counterpart owner, they assert stale review state, refusal by `approvedLiveInventory` and `listDownstreamClaims`, conflict for prior binding publication, and refusal of a newly started downstream module before it creates any run or persists claim status. Arrange/Act/Assert means setting up the approved history, changing ownership, and checking these observable outcomes. Only external coverage providers use existing deterministic test modules; persistence and approval enforcement remain real.

Added a need-only publication test fixture. An existing preservation assertion exposed unordered SQL results on the first covering run; the output showed identical immutable run records in different positions. Both test queries now explicitly order by run ID, preserving exact whole-record equality. The first typecheck caught widened fixture enum strings; the new human tactic fixture now uses correctly typed literal enum values.

### Exact commands and results

All commands ran in `/private/tmp/synapse-kan39-worktree`. Database tests used approved escalated localhost PostgreSQL access.

1. `npx vitest run tests/accuracy-assembly-revision.test.ts -t 'after a new extraction owns its kind' --silent` — exit 1 before production edits; 2 failed, 12 skipped. Initial promise assertions confirmed both readers wrongly succeeded. A second test-only refinement of the same command also exited 1 and recorded all four defect outcomes in each direction: live reads succeeded, downstream execution succeeded, a run was published, and `computed_status` changed.
2. `npx vitest run tests/accuracy-assembly-revision.test.ts tests/accuracy-assembly-approval-integration.test.ts tests/accuracy-assembly-review-store.test.ts --silent` — initial post-fix exit 1; 72 passed, 1 failed. Both new cases passed. Sole failure: `preserves original extraction and evaluator gold scores, and refuses experiment revision targets`, from nondeterministic SQL row order, corrected as described above.
3. Same covering command after the test correction — **exit 0; 3 files, 73 tests passed**: revision 14, KAN-38 approval integration 49, review store 10. Includes generated projection after partial extraction replacement, legacy null behavior, one-kind human-addition success, pre-existing counterpart conflict, and in-flight revision race.
4. `npm run typecheck` — initial exit 2 for the new test fixture's widened enum strings; final rerun **exit 0** (`next typegen && tsc --noEmit`).
5. `npx eslint src/accuracy/store/assembly-review-store.ts tests/accuracy-assembly-revision.test.ts` — **exit 0**, no warnings/errors. Final run after fixture/query corrections.
6. `git diff --check` — **exit 0**, final run after source/test corrections.

### Limits

This correction establishes deterministic backend ownership behavior and preserves the exercised generated/legacy paths. It does not establish real-provider accuracy, frontend/browser behavior, large-history performance, or full integrated-suite success. The whole project suite remains controller-owned at final Task 1 + Task 2 integration; this round ran the specifically assigned covering suites. Added shared-current checks perform extra reads for revised heads; query-scale performance remains unmeasured.

Implemented in `/private/tmp/synapse-kan39-worktree`. No commits, pushes, Jira writes, subagents, or frontend edits. Task 1 is ready for fresh review. The original Task 1/spec files remain controller-owned.

## What changed and why

Human add/edit operations persist a real `human_origin` on a new immutable item version with `run_id: null`, no snapshot, and server subject/provider/actor. Generated versions still require their successful extraction run and exact snapshot/final-output payload. An edit retains the original claim/canonical identity; an addition uses server-created claim/version IDs and a `history_only` backing claim. Removing an item records reasoned lineage without deleting history.

An immutable revision row records the action, author, reason, predecessor/successor, source/provenance, parent, and baseline. A separate head pointer selects the current assembly. The workspace advisory lock and expected parent fingerprint/head protect publication from sibling overwrites. The original baseline assembly, generated run output, and evaluator gold/model scores are untouched.

A revision first saves an assembly and its lineage atomically. Changed pairs use the existing exact-version coverage runner outside database transactions. Unchanged pair decisions survive byte-for-byte. Removed/replaced endpoint pairs disappear from the successor. Successful pair calls have stable operation/version IDs and are reused. Provider failure saves an immutable incomplete assembly plus an append-only error attempt; retry preserves the same revision and creates a new completion assembly, never overwriting failed history or replaying successful provider pairs. A newer extraction or revision head causes stale in-flight publication to conflict.

Approval rechecks exact stored item histories and human revision origins. It follows the current revision pointer for each production baseline. Old baseline approval/reapproval cannot restore eligibility. New approval applies only to the successor's fingerprint/checks. Live inventory and publication binding revalidation consume that exact current successor.

Opposite-kind addition is supported: a gap added to a tactic-only batch (or symmetrically a tactic on a gap-only batch) projects after fresh approval with the baseline's production binding. A separately owned current counterpart extraction scope conflicts and rolls the revision back, rather than silently overriding it. New content must use a source declared in the parent production lineage; edits retain source and claim type.

GET detail supplies authorized source block text for forms, avoiding reliance on the older source-block endpoint. GET list supplies revision state keyed by assembly ID for history labels.

## Changed files

- `src/accuracy/domain/item-history.ts`: nullable generated run plus explicit `HumanItemOrigin`.
- `src/accuracy/domain/assembly-revision.ts` (new): strict change schema and public lineage/state/author types.
- `src/accuracy/kernel/assembly-revision.ts` (new): atomic create, durable linking/retry, stale result rejection.
- `src/accuracy/kernel/assembly-generation.ts`: exports the existing exact pair helpers for reuse.
- `src/accuracy/store/assembly-revision-store.ts` (new): lineage lookup and current head/state resolution.
- `src/accuracy/store/assembly-store.ts`: human origin resolution while preserving generated origin checks.
- `src/accuracy/store/assembly-review-store.ts`: exact history recheck, current revision gating, revised live projection/binding resolution.
- `src/accuracy/store/item-history-store.ts`: exposes human origins in item history.
- `src/accuracy/store/schema.ts`: version origin column/migration plus revision, head, and attempt tables.
- `src/accuracy/store/tenant.ts`: deletes revision dependents before their assembly/version targets.
- `src/app/api/accuracy/assemblies/route.ts`: strict authorized create/retry API, evidence and revision metadata responses.
- `tests/accuracy-assembly-revision.test.ts` (new): 12 direct revision integration tests.

`db.ts` needed no change: its existing migrations and request-local transaction nesting support the new schema and atomic operations. `assembly.ts` remains unchanged: existing whole-set checks and fingerprints already bind full version content, provenance, mappings, coverage, lineage-bearing origins, and linking completeness.

## Task 2 API contract

All requests target `/api/accuracy/assemblies`. All reads and writes require a signed-in account and organization/workspace authorization. Content mutation requires `session.role === "contributor"`; contributor and Medical Affairs approval remain supported. The client must never supply author, approval, origin, lineage, run IDs or mappings.

### GET list

`?workspace_id=<workspace>` returns:

```ts
{
  assemblies: Assembly[];
  revision_states: Record<string, AssemblyRevisionState>; // keyed by assembly ID
}
```

### GET detail

`?workspace_id=<workspace>&assembly_id=<assembly>` returns:

```ts
{
  assembly: Assembly;
  review_state: AssemblyReviewState;
  revision_state: AssemblyRevisionState;
  evidence_blocks: Array<{ id: string; source_file_id: string; text: string }>;
  can_review: boolean;
  can_revise: boolean;
  can_retry_revision: boolean;
}
```

`can_revise` requires contributor, current production head and complete linking. Whole-set blocked checks remain inspectable/correctable. `can_retry_revision` additionally accounts for production supersession, not merely the baseline-local pointer.

### POST create revision

The outer object is strict; unknown fields reject:

```ts
{
  action: "revise";
  workspace_id: string;
  parent_assembly_id: string; // currently displayed saved parent
  expected_fingerprint: string; // its assembly.fingerprint
  expected_head_id: string; // detail.revision_state.current_head_id
  change:
    | { action: "add"; reason: string; content: RevisionContent }
    | { action: "edit"; reason: string; item_version_id: string; content: RevisionContent }
    | { action: "remove"; reason: string; item_version_id: string };
}
```

Reason is trimmed and must be nonempty. Edit/remove IDs must belong to the selected parent. `RevisionContent` has exactly these fields:

```ts
type Provenance = {
  source_file_id: string;
  block_id: string;
  quote: string;
  char_start?: number; // nonnegative integer, existing schema
  char_end?: number; // nonnegative integer, existing schema
};
type RevisionContent =
  | {
      claim_type: "gap";
      source_file_id: string;
      payload: { statement: string; external_id: string | null; provenance: Provenance[] };
    }
  | {
      claim_type: "tactic";
      source_file_id: string;
      payload: {
        name: string;
        type: TacticType;
        status: TacticStatus;
        evidence_question: string;
        origin: "inventory";
        provenance: Provenance[];
      };
    };
```

Payload and content objects are strict. The existing provenance schema accepts optional character positions; source/block/quote are validated server-side against real parse blocks using the existing quote validator (including its whitespace-normalization behavior). At least one provenance span is required. Statement, name and evidence question are trimmed/nonempty. Do not send payload `id`; the server retains the original ID on edits and generates it for additions. `origin: "inventory"` is the existing tactic content schema; actual human authorship is separately and explicitly recorded in `human_origin`.

Import `TACTIC_TYPES`, `TACTIC_TYPE_LABELS`, `TACTIC_STATUSES`, and their types from `src/lib/iegp/enums.ts` for labeled controls. Status enum is `completed | ongoing | planned | proposed | cancelled`. Types are `phase3_trial | rwe_study | registry | chart_review | hcru_study | slr | nma | itc | maic | pro_study | patient_survey | cea | budget_impact_model | iis | academic_collaboration | secondary_analysis | subgroup_analysis | long_term_followup | publication | congress_abstract | evidence_dissemination | natural_history_study`.

### POST retry incomplete revision

```ts
{
  action: "retry_revision";
  workspace_id: string;
  assembly_id: string; // current incomplete saved assembly
  expected_fingerprint: string;
  expected_head_id: string;
}
```

Both mutation responses use:

```ts
{
  ok: true;
  assembly: Assembly; // exact saved successor, including failed linking successor
  revision: AssemblyRevision;
  review_state: AssemblyReviewState;
  revision_state: AssemblyRevisionState;
}
```

A provider failure returns the saved incomplete successor as HTTP 200. UI must show `assembly.linking_complete === false`, blocked checks, `revision_state.linking_error`, and the retry button. This response is a successful durable save, not an approval. A stale parent/new extraction/incompatible scope returns 409. On success refresh to response `assembly.id` and reload detail to obtain fresh approval controls and evidence. On conflict/failed refresh, invalidate previous mutation/approval controls until a successful refresh.

Existing approval POST shape is unchanged: workspace/assembly, expected fingerprint/review ID, decision, rationale, advisory overrides. New revisions always need a fresh approval. Errors follow 400 invalid JSON/schema/content/source quote; 401 signed out; 403 mutation role forbidden; 404 scoped missing; 409 stale/conflict. Unexpected errors log server-side and return generic 500.

### Exported TypeScript types/functions

`src/accuracy/domain/assembly-revision.ts` exports:

```ts
AssemblyRevisionChange // inferred from assemblyRevisionChangeSchema
AssemblyRevisionAuthor = {
  subject: string; provider: string; actor: Actor; role: "contributor";
};
AssemblyRevision = {
  id: string; workspace_id: string; baseline_assembly_id: string; parent_assembly_id: string;
  action: "add" | "edit" | "remove"; reason: string; author: AssemblyRevisionAuthor;
  predecessor_version_id: string | null; successor_version_id: string | null;
  source_file_id: string; provenance: unknown[]; created_at: string;
};
AssemblyRevisionState = {
  revision: AssemblyRevision | null; baseline_assembly_id: string;
  current_head_id: string; is_current: boolean; linking_error: string | null; can_retry: boolean;
};
```

Kernel exports `createAssemblyRevision(args: CreateAssemblyRevisionArgs)` and `retryAssemblyRevision(args: RetryAssemblyRevisionArgs)`, each returning `Promise<AssemblyRevisionResult>` where the result contains assembly/revision/review_state. The args types match the respective request fields without outer action, plus trusted `org_id` and server-owned `author`. Domain `ItemVersion.run_id` is now `string | null`; optional `human_origin` records real human subject/provider/actor, revision ID, action, reason, parent, predecessor, source/provenance, creation time. Frontend should label null-run origins as human and never invent run IDs.

Store exports `revisionForAssembly(workspace_id, assembly_id)`, `assemblyRevisionState(workspace_id, assembly_id)`, and `currentRevisionAssemblyId(workspace_id, baseline_assembly_id)`.

## Verification evidence

Initial test-first command:

`npx vitest run tests/accuracy-assembly-revision.test.ts --silent` — exit 1, missing `@/accuracy/kernel/assembly-revision`, targeting absent implementation.

First post-implementation sandbox test attempt failed on `connect EPERM 127.0.0.1:5432`; all database test runs below were authorized with escalated localhost access. A later focused run had one incorrect expected error code; corrected to the established `approval_required` for blocked checks.

Passed commands:

1. `npx vitest run tests/accuracy-assembly-revision.test.ts tests/accuracy-assembly-approval-integration.test.ts tests/accuracy-assembly-generation.test.ts tests/accuracy-item-history.test.ts --silent` — exit 0; 4 files, 69 tests (11 revision, 49 approval integration, 6 generation, 3 history domain).
2. `npx vitest run tests/accuracy-assembly-api.test.ts tests/accuracy-assembly-review-store.test.ts tests/accuracy-assembly-store.test.ts tests/accuracy-item-history-store.test.ts tests/accuracy-item-history-publication.test.ts tests/accuracy-item-history-eligibility.test.ts tests/accuracy-item-history-api.test.ts --silent` — exit 0; 7 files, 97 tests.
3. After evidence/metadata response additions: `npx vitest run tests/accuracy-assembly-api.test.ts tests/accuracy-assembly-revision.test.ts --silent` — exit 0; 2 files, 19 tests.
4. Final direct downstream publication test: `npx vitest run tests/accuracy-assembly-revision.test.ts --silent` — exit 0; 12 tests. This adds one distinct test to the earlier batches: 167 distinct backend tests passed in total.
5. `npm run typecheck` — exit 0 (`next typegen && tsc --noEmit`), including the last test/API changes before a lint-only test variable rename.
6. `npx eslint src/accuracy/domain/item-history.ts src/accuracy/domain/assembly-revision.ts src/accuracy/store/schema.ts src/accuracy/store/tenant.ts src/accuracy/store/assembly-store.ts src/accuracy/store/assembly-review-store.ts src/accuracy/store/item-history-store.ts src/accuracy/store/assembly-revision-store.ts src/accuracy/kernel/assembly-generation.ts src/accuracy/kernel/assembly-revision.ts src/app/api/accuracy/assemblies/route.ts tests/accuracy-assembly-revision.test.ts` — final run exit 0, no warnings/errors. An earlier run flagged a test variable named `module`; renamed it `downstreamModule` with no behavioral change.
7. `git diff --check` — exit 0.

Direct revision tests cover reasoned remove/fresh approval/baseline preservation; blank reasons and foreign selected IDs; exact add/edit origins and cumulative add→edit→remove; unchanged pair preservation/obsolete pair removal; partial provider failure/retry without replaying success; opposite-kind one-kind-batch projection; new extraction during linking; malformed content/quotes/source rejection and no durable action; signed-out/viewer/Medical Affairs/ungranted/spoofed author API denial; competing contributor serialization; incompatible separate counterpart scope rollback; original extraction bytes/gold/model scores unchanged and experiment revision refusal; downstream exact edited provider input and publication rejection after a concurrent new removal. Existing 49 approval integration tests additionally cover managed module writes/publication gates and transaction rollback.

## Material limits and review points

- Provider evidence uses deterministic registered test modules, not real network/model-provider calls. No clinical recall/accuracy, browser UX, or scale claims.
- Full suite and frontend/browser checks remain Task 2/controller integration work.
- Revision creation allows corrections on complete current assemblies even when whole-set checks are blocked; they remain unapprovable until checks pass. Incomplete revisions require retry before further content changes.
- Provider retries use the existing runner's 20-attempt bound. A persisted running attempt is not duplicated; it remains an explicit refresh/retry conflict pending recovery of that running work.
- Automatic linking saves immutable intermediate and completion assemblies. UI should use revision lineage to label those entries and navigate to the current head.
- List metadata/evidence reads use existing per-assembly query style; no large-history performance claim.
- Human sources must be inside the original assembly's declared production source lineage. Opposite-kind additions are supported where no separate current owner conflicts; incompatible current owners fail closed.
