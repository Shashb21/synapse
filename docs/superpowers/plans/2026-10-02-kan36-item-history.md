# KAN-36 Item History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Execution:** User requested the local subagent-driven-development skill on 2026-10-03. All four tasks implemented and independently reviewed; final whole-branch review pending.

**Goal:** Retain source-backed generated alternatives in one gap/tactic entry, with contributor-confirmed uncertain identity and explicit split/merge ancestry.

**Architecture:** Extend existing claims with immutable Postgres item versions and relationship decisions. Publish histories atomically with extraction batches; preserve existing judged-output behavior while excluding history-only drafts from downstream consumption. Reuse authenticated workspace grants and the existing ledger card for history inspection.

**Tech Stack:** TypeScript, Next.js 16.3.5, Drizzle/Postgres, Zod, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-kan36-item-history-design.md`; Jira KAN-36.

## Global Constraints

- Keep one knowledge-base entry per distinct generated gap or tactic, with inspectable agent-loop alternatives, source/run lineage, and explicit identity decisions.
- A stored draft is available for review but does not acquire downstream eligibility merely by being stored.
- Automatically join only unique exact same-item matches within the same workspace and item type, with matching source-backed content.
- Shared source blocks, array position, similar wording, or a reused external identifier alone do not prove identity.
- Confirmation requires the authenticated contributor identity, a reason, and an atomic workspace-scoped operation. Viewers cannot confirm.
- Splits and merges create new entries.
- Gold reference answers remain evaluator-only.
- Existing claims remain readable; do not fabricate historical runs or snapshots during migration.
- KAN-37 owns mixed assemblies; KAN-38 owns approval of those exact assemblies; KAN-39 owns subsequent human content edits.
- Read applicable installed Next.js guides before changing routes/components. Match existing UI styling; preserve accessibility.
- Workers do not spawn agents, merge, push, or publish. The controller owns git publication and Jira lifecycle.

## Review Focus

- Same quote can support multiple distinct questions: exact payload comparison must distinguish them (Task 1).
- Repeated or concurrent publication must not duplicate versions or produce partial histories (Tasks 1–2).
- Retired identities must resolve to a single visible history without losing original origins or granting eligibility (Task 1).
- History-only claims must remain excluded from every downstream reader, including explicit-ID paths and Gantt helpers (Task 2).
- Authenticated users must not inspect or join another organization's histories; stale decisions must leave no writes (Tasks 1 and 3).

## Shared interfaces and record decisions

Use `src/accuracy/store/item-history-store.ts` for persistence and `src/accuracy/domain/item-history.ts` for pure identity/lineage rules.

Export `ItemHistoryError` with codes `invalid_input`, `not_found`, `conflict`; routes map these to 400/404/409. Export `ItemHistory` with `claim`, `versions`, `relationships`, and `canonical_claim_id`. Versions expose `id`, `claim_id` (original origin), `run_id`, `snapshot_id` (nullable only for a judged final-output record), `iteration` (nullable for that final-output record), `item_index`, `payload`, `source_file_id`, and `created_at`. No client may invent these origins.

Add `metadata.history_only: true` for claims introduced solely for reviewing alternatives. Existing claims without this marker keep existing behavior. Add `isDownstreamClaim(claim)` separately from review visibility; require active status and absence of that marker. Joining identities never changes this marker, validation, or selected payload. A retained judged-output claim is preferred as the canonical entry over a history-only entry; joining two current judged-output entries is a conflict for this ticket because silently removing a downstream item needs an assembly decision.

Version rows are append-only. Relationship proposals and decisions preserve an audit trail; use a proposal record and separate immutable decision record, not overwriting the proposal. Same-item edges consolidate history reads without changing immutable version ownership. A claim retired by confirmed same-item identity uses existing `merged` status/`merged_into` semantics, while original history remains addressable. Reject joining an entry already participating in an incompatible pending/confirmed identity decision. Serialize publication and relationship writes with the existing workspace advisory-lock namespace inside `withAccuracyTransaction`.

### Task 1: Durable histories and explicit identity relationships

**Files:**
- Create: `src/accuracy/domain/item-history.ts`, `src/accuracy/store/item-history-store.ts`
- Modify: `src/accuracy/store/schema.ts`, `src/accuracy/store/tenant.ts`
- Test: `tests/accuracy-item-history.test.ts`, `tests/accuracy-item-history-store.test.ts`

**Interfaces:**
- Produces `generatedItemFingerprint(claim_type: AccuracyClaimType, payload: Record<string, unknown>): string`.
- Produces `readItemHistory(workspace_id: string, claim_id: string): Promise<ItemHistory | null>`.
- Produces `proposeItemRelationship(args: { workspace_id: string; kind: "same_item" | "split" | "merge"; predecessor_ids: string[]; successor_ids: string[]; rationale: string; actor: Actor }): Promise<{ id: string }>`.
- Produces `decideItemRelationship(args: { workspace_id: string; proposal_id: string; action: "confirm" | "reject"; rationale: string; actor: Actor }): Promise<ItemHistory[]>`.
- Produces `publishGeneratedItemHistory(args: { workspace_id: string; source_file_id: string; run_id: string; claim_type: AccuracyClaimType; final_claims: Array<Parameters<typeof insertClaim>[0]> }): Promise<{ claim_ids: string[] }>` for Task 2.

- [x] Write tests first: equal gap payloads with object-key order changes have equal fingerprints; statement/provenance changes differ; two questions sharing one quote differ; gap/tactic types differ; arbitrary external IDs and array positions never establish equality. Fingerprints omit generated `id` only; deterministic canonical JSON preserves all other payload fields and array order. Use Node crypto SHA-256.
- [x] Add store tests: read two versions under one entry; preserve a version's original source/run identity after a confirmed join; cross-workspace predecessors fail; duplicate/self/cyclic ancestry fails; split requires one predecessor and at least two new successors, merge at least two predecessors and one new successor. Require matching types and history-only successors for ancestry operations. Pending proposals change no active entries; rejection joins no histories. Same-item confirmation rejects two non-history-only entries. Conflicting/repeated decisions fail without writes.
- [x] Run `npm test -- tests/accuracy-item-history.test.ts tests/accuracy-item-history-store.test.ts` and confirm failures arise from missing behavior.
- [x] Define the three tables (item versions, relationship proposals, relationship decisions) in Drizzle and DDL with scoped indexes, origin uniqueness, foreign keys, and appropriate workspace deletion cleanup. Add no synthetic legacy history. Ensure cleanup removes dependent records before claims/runs; exercise cleanup in tests.
- [x] Implement persistence under a transaction and workspace lock. Validate claimed origins against successful stored extraction runs, input source/workspace, snapshots and final output, and persisted source records. Resolve raw gap `statement` and tactic `name` through their existing schemas; preserve exact raw payload even if a draft fails final-output validation. Attach exact final matches to their judged claim; store final-only transformations explicitly with null snapshot/iteration rather than pretend they were a raw snapshot. Unique exact matches within source/workspace/type may join automatically; multiple matches become pending identity proposals. Never use gold answers for identity. Proposed uncertain links must cite stored versions and remain review-only until confirmed.
- [x] Run focused tests, including simultaneous publication/confirmation rollback coverage using existing database-test conventions. Commit only Task 1 files and append command/results to the report.

### Task 2: Atomic production and experiment publication with eligibility protection

**Files:**
- Modify: `src/app/api/accuracy/extract/route.ts`, `src/accuracy/experiments/extraction-pipeline.ts`, `src/accuracy/store/claim-store.ts`
- Modify downstream consumers only where needed: `src/accuracy/modules/merge-dedupe/module.ts`, `src/accuracy/modules/status-derive/module.ts`, `src/accuracy/modules/completeness-audit/module.ts`, `src/accuracy/modules/gantt-project/save-final.ts`, and explicit-ID readers discovered by tracing claim inputs.
- Modify if required: `src/accuracy/experiments/copy-workspace.ts`
- Test: `tests/accuracy-item-history-publication.test.ts`, `tests/accuracy-item-history-eligibility.test.ts`; existing extraction/experiment tests.

**Interfaces:**
- Consumes Task 1 `publishGeneratedItemHistory` and `ItemHistoryError`.
- Produces `isDownstreamClaim(claim: Pick<AccuracyClaimRow, "status" | "metadata">): boolean` in claim-store; existing `isActiveLedgerClaim` remains the review-visibility predicate.

- [x] Write tests first for production publication using stored run IDs, raw V0/V1 alternatives and final claims; retries retain one origin record; an intermediate-only distinct item is visible as a history-only draft. Simulate failure during history write and assert batch, final drafts, and histories roll back together.
- [x] Test experiment publication stays in the copied workspace; production receives no writes. Preserve the existing experiment scorer's exact recorded outputs. Baseline copying must preserve history-only exclusion; if history records are copied, remap all origins correctly, otherwise explicitly retain a baseline-origin reference without inventing new snapshot ownership.
- [x] Test history-only exclusion from merge/status, coverage and explicit-ID paths, validation/promotion, completeness inventory, and Gantt projection. Opening or confirming history never grants eligibility; legacy unmarked drafts retain existing behavior. A history-only claim cannot bypass exclusion by client-supplied `validated` or metadata changes.
- [x] Run focused tests and confirm expected failures before implementation.
- [x] Replace final-claim insertion inside `applyExtractionBatch` callbacks with Task 1 publication for each successful extraction run. Keep batch `created_claim_ids` and response counts tied to the judged outputs, not every alternative. Resolve actual canonical claim IDs where exact identities consolidate; keep response/batch references valid. Preserve omission pauses/resume semantics.
- [x] Extend the responsible claim-reader and validation boundaries with `isDownstreamClaim`; trace all consumers rather than rely on UI status alone. Keep unrelated legacy behavior unchanged. Document any required compatibility adjustment in the report.
- [x] Run `npm test -- tests/accuracy-item-history-publication.test.ts tests/accuracy-item-history-eligibility.test.ts tests/accuracy-extract-api.test.ts tests/accuracy-omission-resume.test.ts tests/accuracy-experiment-pipeline.test.ts tests/accuracy-experiment-copy.test.ts`. Fix regressions and commit Task 2.

### Task 3: Authorized history and contributor relationship API

**Files:**
- Create: `src/app/api/accuracy/claims/history/route.ts`, `src/app/api/accuracy/claims/relationships/route.ts`
- Test: `tests/accuracy-item-history-api.test.ts`

**Interfaces:**
- `GET /api/accuracy/claims/history?workspace_id=...&claim_id=...` returns `{ history: ItemHistory }`.
- `POST /api/accuracy/claims/relationships` accepts strict Zod union: propose `{ action: "propose", workspace_id, kind, predecessor_ids, successor_ids, rationale }` or decide `{ action: "confirm" | "reject", workspace_id, proposal_id, rationale }`.
- Consumes Task 1 store functions; actor comes only from `sessionContext()`.

- [x] Read the installed Next.js route-handler guide. Write tests for signed-out 401, viewer write 403, unauthorized workspace 404, invalid/extra fields 400, unknown scoped claim 404, stale decision 409, successful history read and contributor confirm/reject with server actor. Runtime faults return generic 500 and are logged, not leaked.
- [x] Run `npm test -- tests/accuracy-item-history-api.test.ts` to confirm expected failures.
- [x] Implement routes following the authenticated experiment API pattern: signed-in check, capability check for writes, `getAuthorizedWorkspace` with session subject/role, strict parsing, then scoped persistence. Authenticate every read; do not trust request actor names or workspace existence alone. Require trimmed rationale with at least three characters.
- [x] Run the API tests and `npm run typecheck`; commit Task 3 and record results.

### Task 4: Inspect histories and confirm identity from the ledger

**Files:**
- Create: `src/components/accuracy/claim-history.tsx`
- Modify: `src/components/accuracy/ledger-claim-card.tsx`
- Create: `docs/kan-36-item-history.md`
- Test: `tests/accuracy-item-history-ui.test.ts` using established UI-test conventions, or focused Playwright coverage if those conventions require browser interaction.

**Interfaces:**
- `ClaimHistory({ workspaceId, claimId }: { workspaceId: string; claimId: string })` lazily reads Task 3 history, displays alternatives and pending proposals, and posts scoped decisions.

- [x] Read applicable React/Next.js guides and existing ledger styles. Write tests for on-demand reads, empty legacy history, exact version content with run/snapshot/source labels, history-only draft labeling, loading/error/retry, required reason, confirm/reject refresh, and inaccessible write action for viewers. No history-view action changes downstream selection or approval.
- [x] Run UI verification to confirm failures before implementation.
- [x] Add a compact disclosure in the existing card. Use semantic buttons with `aria-expanded`, labeled reason fields, and announced errors. Match existing typography/spacing rather than introducing a new dashboard. Display payload-specific important fields alongside provenance and original IDs; do not force users to read raw JSON for the main flow. Relationships show predecessor/successor IDs with clear split/merge/same-item labels and decision actor/reason.
- [x] Document how to inspect history, confirm an uncertain link, record explicit ancestry, and verify drafts remain excluded; explain conservative matching and KAN-37/KAN-38 boundaries.
- [x] Run UI verification, `npm run typecheck`, and `npx eslint` on changed files. Run the full Vitest suite once for final integration proof. Commit Task 4, provide evidence for final branch review, and report material limitations.

## Controller completion

Use task-scoped spec/quality reviews after every task, then one whole-branch review. Keep the SDD ledger and reports in this plan's workspace; record all rulings and deferred findings. Do not mark KAN-36 Done until sufficient verification passes, a concise Jira implementation/verification/limitations comment succeeds, and Jira confirms its Done transition. Published commits must reach both origin and github via `scripts/push-both.sh`; get approval if publication is not already authorized. Only then select the eligible next Jira issue and arm the one-shot handoff with the confirmed transition and complete next-issue context.
