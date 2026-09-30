# KAN-33 Omission Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause downstream accuracy work while an important source-linked extraction omission remains unresolved, and let an authorized contributor resolve or reclassify the exact finding without duplicating an equivalent knowledge-base item.

**Architecture:** Read the terminal KAN-32 completeness assessment from the latest successful need/inventory run for each source and call kind. Store contributor decisions as an append-only, workspace-scoped action history; the latest valid action determines whether each finding still blocks. A central run guard protects downstream call kinds, while the composed extraction API returns a reviewable paused response and offers an explicit resume path.

**Tech Stack:** TypeScript, Next.js 16, Zod, Drizzle/Postgres, Vitest, existing session/role helpers.

**Spec:** `docs/superpowers/specs/2026-09-29-kan4-agent-loop-design.md`; Jira KAN-33.

## Global Constraints

- Apply to `src/accuracy/`, not legacy S0–S10. KAN-32 retains its one-revision production default and its immutable snapshot/critique records.
- Only unresolved **important** source-linked findings pause downstream use. Advisory findings remain visible and do not pause. A failed check must stay visibly failed, never be shown as a clean check; KAN-33 does not reinterpret it as an important source-linked finding.
- Keep extraction drafts in the knowledge base for review, but do not run merge, status, coverage, validation, ideation, or later downstream modules while a latest-run blocker remains. Permit parse, extraction, and the standalone completeness review.
- A decision must bind to the exact workspace, extraction run, and omission issue ID. A contributor or Medical Affairs lead needs the existing `validate` capability; session identity wins over body actor fields. Every decision records a nonempty reason and actor identity.
- `add` creates a source-backed draft only when no clear equivalent exists; `link_existing` adds evidence to an active same-kind entry; `dismiss` and `reclassify` record reason and identity. Exact normalized equivalents must use `link_existing`. Ambiguous lexical matches require an explicit `confirmed_distinct` choice before `add`.
- A newer successful extraction run for the same source and call kind supersedes an older run's blockers; actions remain in history. A reclassified advisory finding is nonblocking. A reclassified important finding still blocks until a later closing action.
- An action is a decision on the current finding. A second decision on an already closed finding is a conflict; a replay of the same idempotency key returns the original result only when its request payload matches. A different payload using that key is a conflict.
- Preserve tenant isolation, quote validation, atomic claim/action writes, serialized decisions for one run/issue, and idempotent request retries. No gold metrics enter production records.
- The existing KAN-31/32 branch remains unmerged; KAN-33 starts from its reviewed head `6e13af9`.

## Review Focus

1. Two omissions in one source block: resolving one leaves the other blocking (Task 1).
2. Another workspace's run, issue, block, or claim ID is submitted: action is rejected without mutation (Task 2).
3. A repeated request after a timeout: the same idempotency key returns the original decision and does not create another claim or provenance span (Task 2).
4. A direct downstream module call bypasses the composed extraction route: the shared run guard still pauses it (Task 3).
5. The last blocker is resolved: explicit resume runs merge/status once for that extraction set without re-extracting or inserting duplicate drafts (Task 3).

---

### Task 1: Latest-run omission state and action history

**Files:**
- Modify: `src/accuracy/store/schema.ts` — action table, unique workspace-scoped idempotency key, supporting indexes, additive DDL/migration; include the resume journal table owned by Task 3.
- Create: `src/accuracy/store/omission-review-store.ts` — latest-run findings, latest actions, blocker calculation, typed history access.
- Test: `tests/accuracy-omission-review-store.test.ts`.

**Interfaces:**
- Export `OmissionReviewItem = { workspace_id: string; source_file_id: string; run_id: string; call_kind: "need_extract" | "inventory_extract"; issue: SuspectedOmission; latest_action: OmissionAction | null; blocking: boolean }`.
- Export `listCurrentOmissionReviews(workspace_id: string): Promise<OmissionReviewItem[]>` and `listBlockingOmissions(workspace_id: string): Promise<OmissionReviewItem[]>`.
- Export `listOmissionActionHistory({ workspace_id, run_id, issue_id? }): Promise<OmissionAction[]>`.
- `OmissionAction` stores action `add | link_existing | dismiss | reclassify`, optional claim ID or new importance, reason, actor name/function, timestamp, run/issue/workspace/source identity, and caller idempotency key. Keep an append-only history; latest action decides the effective block state.
- Store a canonical request fingerprint alongside each action so an idempotency key cannot silently replay a different decision. The resume journal has a unique `(workspace_id, source_file_id, extraction_set_key)` and stores status, resulting merge/status run IDs and response; `extraction_set_key` is the sorted exact extraction run IDs and call kinds. Task 3 owns the journal's read/write logic.

- [ ] **Step 1: Write failing database tests.** Persist KAN-32 terminal critiques for two same-block issues; assert both appear and each can block independently. Assert an advisory finding stays visible/nonblocking. Assert latest successful run per source and call kind supersedes an older blocked run. Assert unrelated workspace/source cannot appear. Assert reclassify-advisory and close actions remove only their issue from blockers, while reclassify-important remains blocking.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-review-store.test.ts` with local Postgres access and confirm the new tests fail before implementation.**
- [ ] **Step 3: Add table and read model.** Query only successful need/inventory runs, choose latest by finish time plus ID for each `(source_file_id, call_kind)`, use the terminal critique's `suspected_omissions`, and overlay the latest action per run/issue. Use one shared decision function for the `blocking` flag; source-linked issue identity comes from persisted KAN-32 evidence, not a client payload. Index the workspace/run/action lookups. Preserve historical actions when a newer extraction supersedes them. Add the resume journal schema now for Task 3.
- [ ] **Step 4: Run focused tests, typecheck, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-review-store.test.ts`; `npm run typecheck`; commit `feat(kan-33): track current omission blockers`.

### Task 2: Authorized contributor resolution actions

**Files:**
- Modify: `src/accuracy/store/omission-review-store.ts` — transactional action writer and idempotency.
- Modify: `src/accuracy/store/claim-store.ts` — transactional source-backed claim/provenance mutation if needed; keep existing claim public behavior.
- Create: `src/app/api/accuracy/omissions/route.ts` — GET current review items and POST one action.
- Test: `tests/accuracy-omission-actions.test.ts`.

**Interfaces:**
- Export `applyOmissionAction(args: { workspace_id; run_id; issue_id; action; reason; actor; idempotency_key; claim_id?; statement?; new_importance?; confirmed_distinct? }): Promise<OmissionAction>` with a discriminated union for action-specific fields.
- GET `/api/accuracy/omissions?workspace_id=…` returns current review items and latest action; POST validates action-specific input and returns the recorded action/claim ID.

- [ ] **Step 1: Write failing API/store tests.** Exercise authorized add, link, dismiss, reclassify, viewer rejection, unsigned non-demo rejection, session actor overriding spoofed body actor, wrong workspace/run/issue/claim, invalid source quote, blank reason, same-kind claim validation, exact duplicate add rejection, ambiguous match requiring `confirmed_distinct`, and idempotent retry. Confirm two concurrent decisions on one issue cannot create duplicate claims or silently overwrite one another.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-actions.test.ts` and confirm failure.**
- [ ] **Step 3: Implement the action boundary.** Use `requestIdentity` and `assertCan(role, "validate")`; require signed-in identity outside demo. Derive the finding from the terminal persisted assessment, revalidate its source block and quote, and ignore actor/issue detail supplied by the body. Serialize mutations for an issue in a database transaction, append exactly one action for each idempotency key, and mutate the claim in the same transaction. Compare the canonical request fingerprint on replay; reject key reuse with changed contents. `add` creates one draft with the finding's source span; `link_existing` appends that span only if absent to a workspace-owned active same-kind claim. A clear exact equivalent blocks `add`; an ambiguous overlap returns candidates and needs explicit distinct confirmation. `dismiss` and `reclassify` only write the action history. Return 401/403/404/409 for the corresponding trust or conflict cases.
- [ ] **Step 4: Run focused tests, typecheck, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-actions.test.ts`; `npm run typecheck`; commit `feat(kan-33): resolve omissions with audited actions`.

### Task 3: Pause every downstream path and resume the composed pipeline

**Files:**
- Modify: `src/accuracy/kernel/run.ts` — shared downstream guard before module execution.
- Create: `src/accuracy/kernel/omission-pause.ts` — guarded call-kind set and typed pause error, using Task 1 blockers.
- Modify: `src/app/api/accuracy/extract/route.ts` — paused response after draft insertion, explicit resume without re-extraction.
- Modify: `src/app/api/accuracy/coverage/route.ts`, `src/app/api/accuracy/coverage/assist/route.ts`, `src/app/api/accuracy/claims/validate/route.ts`, `src/app/api/accuracy/ideate/route.ts` — map typed pause to HTTP 409 where they call guarded downstream kinds.
- Test: `tests/accuracy-omission-pause.test.ts`, `tests/accuracy-extract-api.test.ts`.

**Interfaces:**
- Export `AccuracyPausedError` with structured blockers and `assertAccuracyCanProgress(workspace_id, call_kind)`. Guard merge, pair generation, coverage, validation, status, prioritization, ideation, and projection call kinds; allow extraction and completeness review.
- Extraction POST returns HTTP 409 `{ ok:false, paused:true, blockers, runs, gaps_inserted, tactics_inserted }` after storing drafts when blockers exist. A `resume` action for the specified workspace/source and extraction run IDs skips extraction, checks blockers, then runs merge/status and returns their result.
- `resume` uses the journal from Task 1. Under a workspace/source database lock, it rejects a stale extraction set, returns a completed journal response on retry, and executes missing merge/status stages once. Store each stage's run ID immediately after completion so an interrupted resume can continue from the next stage. The journal is the source of truth for completed stages; the client idempotency key is only a retry identifier.

- [ ] **Step 1: Write failing gate and route tests.** Important unresolved finding blocks direct `runAccuracyModule` for downstream kinds and composed merge/status; advisory does not. Paused extraction returns recorded run IDs/draft counts and does not run merge/status. Resolve the final blocker and resume: merge/status run, no new extraction or draft insertion. A stale resume token or changed latest extraction set is rejected. A repeated resume does not duplicate downstream effects. Preexisting tests with no blockers keep their response behavior.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-pause.test.ts tests/accuracy-extract-api.test.ts` and confirm failure.**
- [ ] **Step 3: Implement the central guard and route flow.** Guard at `runAccuracyModule` so alternate APIs cannot bypass the pause. After both requested extractors and draft inserts, call the same gate before merge/status. Add an explicit resume branch bound to the latest extract run IDs and workspace/source, using the durable journal and lock above. A retry returns the stored result or continues an incomplete stage without re-extraction. Map `AccuracyPausedError` to 409 without leaking another workspace's findings. Keep the no-blocker extraction response unchanged. Read the installed Next route guide before editing route files.
- [ ] **Step 4: Run focused tests, typecheck, targeted ESLint, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-omission-pause.test.ts tests/accuracy-extract-api.test.ts`; `npm run typecheck`; `npx eslint src/accuracy/kernel/run.ts src/accuracy/kernel/omission-pause.ts src/app/api/accuracy/extract/route.ts`; commit `feat(kan-33): pause downstream use until resolved`.

### Task 4: Contributor review controls and visible pause state

**Files:**
- Modify: `src/app/accuracy/runs/[run_id]/page.tsx` — show current action status and a contributor action entry point for each finding.
- Create: `src/app/accuracy/runs/[run_id]/omission-actions.tsx` — small client form for add/link/dismiss/reclassify, reason, and ambiguous-identity confirmation.
- Test: `tests/accuracy-agent-events.test.ts` and `tests/accuracy-omission-actions.test.ts`.

**Interfaces:**
- Consume Task 2 API and current review items, keyed by exact run/issue; show blocking versus advisory and the latest actor/reason. Use browser-generated idempotency key per submit attempt and retain it for retries.

- [ ] **Step 1: Write failing rendering/interaction tests.** An important open issue shows paused state and four contributor actions; advisory remains visible without a pause label. A linked item shows its claim ID and recorded reason/actor. Viewer sees status but cannot submit. A conflict response asks for an explicit distinct-item confirmation and does not silently retry `add`. The original issue and later action can be matched by ID.
- [ ] **Step 2: Run focused tests and confirm failure.** `npm test -- --silent --maxWorkers=2 tests/accuracy-agent-events.test.ts tests/accuracy-omission-actions.test.ts`.
- [ ] **Step 3: Implement the minimal controls in the existing run-detail design.** Read the relevant `node_modules/next/dist/docs/` guide and `/Users/calixtan/.codex/skills/uncodixfy/SKILL.md` before JSX changes. Use the authenticated session role for visibility; server API remains the authorization boundary. Show errors and pending state, and link a paused run to its resume action after all blockers clear.
- [ ] **Step 4: Run focused tests, typecheck, targeted ESLint, the full suite with two workers, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-agent-events.test.ts tests/accuracy-omission-actions.test.ts`; `npm run typecheck`; `npx eslint 'src/app/accuracy/runs/[run_id]/page.tsx' 'src/app/accuracy/runs/[run_id]/omission-actions.tsx'`; `npm test -- --silent --maxWorkers=2`; commit `feat(kan-33): review and resolve paused omissions`.
