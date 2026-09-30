# KAN-33 Omission Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause downstream accuracy work while an important source-linked extraction omission remains unresolved, and let an authorized contributor resolve or reclassify the exact finding without duplicating an equivalent knowledge-base item.

**Architecture:** Read the terminal KAN-32 completeness assessment from the latest fully applied extraction batch for each source and call kind. An applied batch has persisted every requested draft. Store contributor decisions as an append-only, workspace-scoped action history; the latest valid action determines whether each finding still blocks. A central run guard and route preflights protect downstream operations, while the composed extraction API returns a reviewable paused response and offers an explicit resume path.

**Tech Stack:** TypeScript, Next.js 16, Zod, Drizzle/Postgres, Vitest, existing session/role helpers.

**Spec:** `docs/superpowers/specs/2026-09-29-kan4-agent-loop-design.md`; Jira KAN-33.

## Global Constraints

- Apply to `src/accuracy/`, not legacy S0–S10. KAN-32 retains its one-revision production default and its immutable snapshot/critique records.
- Only unresolved **important** source-linked findings pause downstream use. Advisory findings remain visible and do not pause. A failed check must stay visibly failed, never be shown as a clean check; KAN-33 does not reinterpret it as an important source-linked finding. Important findings retained in a failed terminal assessment still block.
- Keep extraction drafts in the knowledge base for review, but do not run merge, status, coverage, validation, ideation, or later downstream modules while a latest-run blocker remains. Permit parse, extraction, and the standalone completeness review.
- A decision must bind to the exact workspace, extraction run, and omission issue ID. A contributor or Medical Affairs lead needs the existing `validate` capability; session identity wins over body actor fields. Every decision records a nonempty reason and actor identity.
- `add` creates a source-backed draft only when no clear equivalent exists; `link_existing` adds evidence to an active same-kind entry; `dismiss` and `reclassify` record reason and identity. Exact normalized equivalents must use `link_existing`. Ambiguous lexical matches require an explicit `confirmed_distinct` choice before `add`.
- A newer **fully applied batch** for the same source and call kind supersedes an older run's blockers; an OK module run with incomplete draft persistence does not. Actions remain in history. A reclassified advisory finding is nonblocking. A reclassified important finding still blocks until a later closing action. Pre-KAN-33 runs have no applied batch marker; keep them visible in history and require a new extraction for enforceable current state.
- An action is a decision on the current finding. A second decision on an already closed finding is a conflict; a replay of the same idempotency key returns the original result only when its request payload matches. A different payload using that key is a conflict.
- Preserve tenant isolation, quote validation, atomic claim/action writes, serialized decisions for one run/issue, and idempotent request retries. No gold metrics enter production records.
- The existing KAN-31/32 branch remains unmerged; KAN-33 starts from its reviewed head `6e13af9`.

## Review Focus

1. Two omissions in one source block: resolving one leaves the other blocking (Task 1).
2. Another workspace's run, issue, block, or claim ID is submitted: action is rejected without mutation (Task 2).
3. A repeated request after a timeout: the same idempotency key returns the original decision and does not create another claim or provenance span (Task 2).
4. A direct downstream module call bypasses the composed extraction route: the shared run guard still pauses it (Task 3).
5. The last blocker is resolved: explicit resume runs merge/status once for that extraction set without re-extracting or inserting duplicate drafts (Task 4).

---

### Task 1: Latest-run omission state and action history

**Files:**
- Modify: `src/accuracy/store/schema.ts` — action, extraction batch, and resume journal tables with workspace-scoped keys, indexes, additive DDL/migration.
- Modify: `src/accuracy/store/tenant.ts` — delete the new workspace-scoped rows in FK-safe order during workspace removal.
- Create: `src/accuracy/store/omission-review-store.ts` — latest-run findings, latest actions, blocker calculation, typed history access.
- Test: `tests/accuracy-omission-review-store.test.ts` and the existing workspace-deletion test.

**Interfaces:**
- Export `OmissionReviewItem = { workspace_id: string; source_file_id: string; run_id: string; call_kind: "need_extract" | "inventory_extract"; issue: SuspectedOmission; latest_action: OmissionAction | null; blocking: boolean }`.
- Export `listCurrentOmissionReviews(workspace_id: string): Promise<OmissionReviewItem[]>` and `listBlockingOmissions(workspace_id: string): Promise<OmissionReviewItem[]>`.
- Export `listOmissionActionHistory({ workspace_id, run_id, issue_id? }): Promise<OmissionAction[]>`.
- Export `getOmissionReviewsForRun({ workspace_id, run_id }): Promise<{ current: boolean; items: OmissionReviewItem[] } | null>` for historical run detail. Superseded findings remain auditable and cannot receive new actions.
- `OmissionAction` stores action `add | link_existing | dismiss | reclassify`, optional claim ID or new importance, reason, actor name/function, timestamp, run/issue/workspace/source identity, and caller idempotency key. Keep an append-only history; latest action decides the effective block state.
- Store a canonical request fingerprint alongside each action so an idempotency key cannot silently replay a different decision. The extraction batch records workspace/source, requested kinds, run IDs, created claim IDs, and `drafts_persisted` state. The resume journal has a unique batch ID and records a reserved stable operation ID for each merge/status stage, each stage's state, and its final response. Task 3 owns batch and journal writes.

- [ ] **Step 1: Write failing database tests.** Persist KAN-32 terminal critiques for two same-block issues in applied batches; assert both appear and each can block independently. Assert an advisory finding stays visible/nonblocking. Assert a newer applied batch supersedes an older blocked run; an OK run whose drafts were not fully persisted does not. Assert unrelated workspace/source cannot appear. Assert reclassify-advisory and close actions remove only their issue from blockers, while reclassify-important remains blocking. Deleting a workspace removes its new action/batch/journal records.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-review-store.test.ts` with local Postgres access and confirm the new tests fail before implementation.**
- [ ] **Step 3: Add tables and read model.** Query only OK need/inventory runs named by applied batches, choose latest by finish time plus ID for each `(source_file_id, call_kind)`, select the highest critique iteration, and overlay the latest action per run/issue. Verify each persisted run input identifies the batch's workspace/source/kind. Treat `check_failed` as visible check state, retaining any explicit important findings rather than synthesizing new ones. Use one shared decision function for the `blocking` flag; source-linked issue identity comes from persisted KAN-32 evidence, not a client payload. Preserve historical actions when a newer extraction supersedes them. Add batch and resume journal schemas now for Task 3.
- [ ] **Step 4: Run focused tests, typecheck, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-review-store.test.ts`; `npm run typecheck`; commit `feat(kan-33): track current omission blockers`.

### Task 2: Authorized contributor resolution actions

**Files:**
- Modify: `src/accuracy/store/omission-review-store.ts` — transactional action writer and idempotency.
- Modify: `src/accuracy/store/claim-store.ts` — transactional source-backed claim/provenance mutation if needed; keep existing claim public behavior.
- Create: `src/app/api/accuracy/omissions/route.ts` — GET current review items and POST one action.
- Test: `tests/accuracy-omission-actions.test.ts`.

**Interfaces:**
- Export `applyOmissionAction(args: { workspace_id; run_id; issue_id; action; reason; actor; idempotency_key; claim_id?; statement?; new_importance?; confirmed_distinct? }): Promise<OmissionAction>` with a discriminated union for action-specific fields.
- GET `/api/accuracy/omissions?workspace_id=…` returns current review items and latest action; optional `run_id` returns that run's findings, actions, and `current` state. POST validates action-specific input and returns the recorded action/claim ID.

- [ ] **Step 1: Write failing API/store tests.** Exercise authorized add, link, dismiss, reclassify, viewer rejection, unsigned non-demo rejection, session actor overriding spoofed body actor, wrong workspace/run/issue/claim, invalid source quote, blank reason, same-kind claim validation, exact duplicate add rejection, ambiguous match requiring `confirmed_distinct`, and idempotent retry. Cover inactive claims, reference-pack boundaries, and tactic lifecycle conflicts in equivalent matching. Confirm two concurrent decisions on one issue cannot create duplicate claims or silently overwrite one another. A superseded run remains readable with its action history but rejects a new decision.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-actions.test.ts` and confirm failure.**
- [ ] **Step 3: Implement the action boundary.** Use `requestIdentity` and `assertCan(role, "validate")`; require signed-in identity outside demo. Derive the finding from the terminal persisted assessment, revalidate its source block and quote, and ignore actor/issue detail supplied by the body. Lock the parent run row in a database transaction; re-read current issue state under that lock. Make claim creation/provenance and action insertion use the same transaction executor. Keep `claims.metadata.provenance` canonical because the existing merge reader uses it. Compare the canonical request fingerprint on replay; reject key reuse with changed contents. `add` creates one draft with the finding's source span; `link_existing` appends that span only if absent to a workspace-owned active same-kind claim. Reuse merge/dedupe engine identity and lexical similarity rules: same-kind, compatible-pack strong ID or exact normalized statement must link; same-block Jaccard >=0.9 must link; same-block Jaccard >=0.5 and <0.9 is ambiguous and needs explicit distinct confirmation. Exclude inactive claims and surface tactic lifecycle conflicts rather than silently linking. Record a supplied statement in the created claim and action history as contributor-authored, never as model output. `add`, `link_existing`, `dismiss`, and reclassify-to-advisory close; reclassify-to-important stays open. A new action against a closed issue conflicts. Return 401/403/404/409 for the corresponding trust or conflict cases.
- [ ] **Step 4: Run focused tests, typecheck, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-actions.test.ts`; `npm run typecheck`; commit `feat(kan-33): resolve omissions with audited actions`.

### Task 3: Guard every downstream execution path

**Files:**
- Modify: `src/accuracy/kernel/run.ts` — shared downstream guard before module execution.
- Create: `src/accuracy/kernel/omission-pause.ts` — guarded call-kind set and typed pause error, using Task 1 blockers.
- Modify: downstream accuracy routes including coverage, coverage assist, validation, ideation, priority, and Gantt projection/save-final — preflight before any direct mutation or projection; map typed pause to HTTP 409.
- Test: `tests/accuracy-omission-pause.test.ts` and affected route tests.

**Interfaces:**
- Export `AccuracyPausedError` with structured blockers and `assertAccuracyCanProgress(workspace_id, call_kind)`. Guard merge, pair generation, coverage, validation, status, prioritization, ideation, and projection call kinds; allow extraction and completeness review.
- Enumerate guarded call kinds: `merge_dedupe`, `pair_generate`, `coverage_decide`, `coverage_critic`, `validation_gate`, `status_derive`, `partial_split`, `prioritize`, `ideate`, `gantt_project`. Allow `upload`, `parse`, `need_extract`, `inventory_extract`, `completeness_audit`. Test the policy for every `CALL_KINDS` value.

- [ ] **Step 1: Write failing gate and route tests.** Important unresolved finding blocks direct `runAccuracyModule` for downstream kinds; table-test all `CALL_KINDS`; conflicting outer/input workspace IDs or org ownership are rejected before any run. Direct coverage, manual ideation, priority, and projection routes make no mutation while paused. Advisory does not block. Existing no-blocker behavior remains.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-pause.test.ts` and confirm failure.**
- [ ] **Step 3: Implement the central guard and route preflights.** Validate parsed module input workspace against the trusted outer workspace and its org before opening a run, then guard downstream calls at `runAccuracyModule`. Preflight routes whose direct writes or projections occur outside that runner; map `AccuracyPausedError` to 409 without leaking another workspace's findings. Read the installed Next route guide before editing route files.
- [ ] **Step 4: Run focused tests, typecheck, targeted ESLint, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-pause.test.ts`; `npm run typecheck`; lint touched files; commit `feat(kan-33): guard downstream accuracy paths`.

### Task 4: Apply extraction batches and safely resume

**Files:**
- Modify: `src/app/api/accuracy/extract/route.ts` — fully applied batch, paused response, explicit resume without re-extraction.
- Modify: `src/accuracy/kernel/observability.ts` and `src/accuracy/kernel/run.ts` — reserved stable run ID for recoverable resume stages.
- Create: `src/accuracy/store/extraction-batch-store.ts` — batch and resume journal state transitions.
- Test: `tests/accuracy-extract-api.test.ts`, `tests/accuracy-omission-resume.test.ts`.

**Interfaces:**
- Extraction POST accepts today's request body or `{ action: "resume", workspace_id, source_file_id, extraction_batch_id, idempotency_key }`. A paused extraction returns HTTP 409 `{ ok:false, paused:true, blockers, extraction_batch_id, runs, gaps_inserted, tactics_inserted }`. The run-scoped GET response includes its server-owned `extraction_batch_id` for the review page. Resume loads its run IDs from that batch, skips extraction, checks blockers, then runs merge/status. Still blocked returns 409 with `paused:true`; stale/mismatched batch returns 409 with `code:"stale_batch"`; concurrent resume returns 409 with `code:"resume_in_progress"`; completed and replayed resume return the same stored 200 response.
- `resume` uses the batch and journal from Task 1. Under a workspace/source database lock, it checks the stored batch belongs to the workspace/source, is fully applied, contains the requested run IDs and kinds, and remains the latest applied set. Reserve a stable operation/run ID before each merge/status stage and use it to find an already completed module run on recovery. A completed journal response is returned on retry; interrupted stages resume from their durable state without duplicating downstream effects.

- [ ] **Step 1: Write failing batch and resume tests.** Paused extraction returns run IDs, draft counts and a server-owned batch ID, without merge/status. An OK extractor whose draft persistence fails does not supersede an older blocker. Resolve the final blocker and resume: merge/status run, no new extraction or draft insertion. A stale/mismatched batch or changed latest extraction set is rejected. A repeated or interrupted resume does not duplicate downstream effects. Preexisting tests with no blockers keep their response behavior.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-extract-api.test.ts tests/accuracy-omission-resume.test.ts` and confirm failure.**
- [ ] **Step 3: Implement batch and resume transitions.** Create a batch before running extractors; mark it fully applied only after all requested runs and drafts persist. Then call Task 3's gate before merge/status. Add the explicit resume branch bound to the latest applied batch, using the durable journal and lock above. A retry returns the stored result or recovers a stage without re-extraction. Keep the no-blocker extraction response unchanged. Read the installed Next route guide before editing.
- [ ] **Step 4: Run focused tests, typecheck, targeted ESLint, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-extract-api.test.ts tests/accuracy-omission-resume.test.ts`; `npm run typecheck`; lint touched files; commit `feat(kan-33): pause and resume extraction batches`.

### Task 5: Contributor review controls and visible pause state

**Files:**
- Modify: `src/app/accuracy/runs/[run_id]/page.tsx` — show current action status and a contributor action entry point for each finding.
- Create: `src/app/accuracy/runs/[run_id]/omission-actions.tsx` — small client form for add/link/dismiss/reclassify, reason, and ambiguous-identity confirmation.
- Test: `tests/accuracy-agent-events.test.ts` and `tests/accuracy-omission-actions.test.ts`.

**Interfaces:**
- Consume Task 2's run-scoped API and Task 4's resume contract, keyed by exact run/issue; show current versus superseded, blocking versus advisory, and the latest actor/reason. Use browser-generated idempotency key per submit attempt and retain it for retries. Read the server-owned extraction batch ID from the run-scoped lookup; do not reconstruct it from one run's events.

- [ ] **Step 1: Write failing rendering/interaction tests.** An important open issue shows paused state and four contributor actions; advisory remains visible without a pause label. A linked item shows its claim ID and recorded reason/actor. Viewer sees status but cannot submit. A conflict response asks for an explicit distinct-item confirmation and does not silently retry `add`. The original issue and later action can be matched by ID.
- [ ] **Step 2: Run focused tests and confirm failure.** `npm test -- --silent --maxWorkers=2 tests/accuracy-agent-events.test.ts tests/accuracy-omission-actions.test.ts`.
- [ ] **Step 3: Implement the minimal controls in the existing run-detail design.** Read the relevant `node_modules/next/dist/docs/` guide and `/Users/calixtan/.codex/skills/uncodixfy/SKILL.md` before JSX changes. Use the authenticated session role for visibility; server API remains the authorization boundary. Show errors and pending state, and link a paused run to its resume action after all blockers clear.
- [ ] **Step 4: Run focused tests, typecheck, targeted ESLint, the full suite with two workers, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-agent-events.test.ts tests/accuracy-omission-actions.test.ts`; `npm run typecheck`; `npx eslint 'src/app/accuracy/runs/[run_id]/page.tsx' 'src/app/accuracy/runs/[run_id]/omission-actions.tsx'`; `npm test -- --silent --maxWorkers=2`; commit `feat(kan-33): review and resolve paused omissions`.
