# KAN-83 Stage Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete source-backed extraction, exhaustive gap–inventory assessment, consistent status, confirmed residual splits and authoritative S8 prioritisation, then merge KAN-83 into KAN4.

**Architecture:** Extend existing Accuracy stores and human-edit boundaries. Share pure status and S8 scoring rules across store-specific adapters; keep Accuracy transactions entirely in its database context. Reconcile the main baseline with KAN4 before feature changes so the final result preserves both customer-stage improvements and experiment controls.

**Tech Stack:** TypeScript, Next.js 16.3.5, React 19, Zod 4, Drizzle/PostgreSQL, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-kan83-stage-completion-design.md` (approved by the user on 2026-10-07).

## Global Constraints

- Final integration target is existing `KAN4` (the user's “kan-4”); feature branch is `KAN-83`. Preserve the dirty original checkout and its unrelated documents.
- Use an isolated worktree. Feature implementation starts only after this plan is reviewed. Per-task implementation uses delegate-implement scripts, with fresh workers and independent SDD task reviews; parent performs Git integration/publication.
- Source baselines: `github/main` at `3eb28c15fe4d0155b679380f98e81e9c8c8554e3`, `KAN4` at `075e597`. Re-fetch and record movement before integration.
- Preserve KAN4 agent events, omission pause/review, extraction batches, transaction context, experiment isolation and pass comparisons. Preserve main owner authentication, AI-off behaviour, source matching, human field locks and configurable S8 quadrants.
- Reuse existing TypeScript tests. Jira explicitly requests Vitest/Playwright for this ticket; do not add a Python test layer.
- Read relevant installed Next.js guides before route/component edits. Read uncodixfy before frontend changes; extend existing screens without redesign.
- Model suggestions never become human validation. Require authenticated actor and rationale for human decisions; validate workspace identity and factual provenance before writes.
- Proposed/cancelled/unknown lifecycle never addresses a gap. Current validated Full dominates Partial/Limited; multiple Partial never imply Full.
- Keep canonical `limited`, explicit pending, source completeness, missing facts and stale validation visible. Legacy missing facts become unknown, never fabricated defaults.
- KAN-17 retains legacy priority retirement; keep legacy mirroring/consumers. Preserve S8's `high/medium/low/defer` bands and saved axis direction.
- Reuse `preserveHumanLocks`, `withHumanEdit`, claim edit/merge and existing history conventions. Do not implement KAN-36's general history product or KAN-81 audit product.
- Use `withAccuracyTransaction` for atomic Accuracy writes. No model requests inside a transaction. Protect retries with unique operation/pair keys and expected input revisions.
- Record every verification command/result. Do not claim live-model accuracy from fixtures. Jira Done requires passed verification, reported limitations, successful summary comment and successful transition.
- Publish only through `scripts/push-both.sh` so every published commit reaches both remotes. Final merge is already requested; validate the integrated result before publishing KAN4.

## Review Focus

- Branch reconciliation can accidentally weaken owner authentication or drop omission guards: Task 1 tests both and preserves refusal before writes.
- An oversized source block can lose text or corrupt quote offsets: Task 3 checks contiguous subdivisions and original block offsets.
- A paged coverage cursor can silently omit work after entity edits: Task 4 rejects changed snapshots and reports pending work.
- A split retry or rollback can overwrite a later human edit: Task 6 tests concurrent apply, exact restoration and blocked rollback.
- Axis configuration changes can leave a human priority looking fresh: Task 7 retains the old decision/actor and marks its validation stale.

## File ownership and dependency map

Task 1 owns only main/KAN4 reconciliation. Tasks 2–3 extend extraction modules, claim metadata and extract persistence. Task 4 owns coverage store/API/queue; Task 5 owns shared status and callers. Task 6 owns Accuracy split persistence and its confirmation API. Task 7 owns shared S8 scoring and workspace placements. Task 8 connects these behaviours to existing screens and verifies the workflow.

Add focused files only for responsibilities without an existing owner: structured field schema, source-page construction, shared pure status, Accuracy split operation persistence, Accuracy priority placement persistence. Additive schema changes belong in `src/accuracy/store/schema.ts` and its DDL/migrations; include experiment-copy/workspace-cleanup support for each new workspace table. Later tasks consume earlier Interfaces blocks; do not invent alternate copies of their rules.

### Task 1: Reconcile the two required baselines

**Files:** Reconcile conflicts in `docs/deploy-checklist.md`; `src/accuracy/kernel/run.ts`; need/inventory `module.ts`; `src/accuracy/store/schema.ts`; admin coverage/timeline pages; Accuracy API claims, validate, priority, coverage, assist, extract, gantt, save-final, ideate, workshop/actions/tags, workspaces routes; `src/modules/auth/roles.ts`; deleted/modified module-run and parse-ingest tests. Inspect all auto-merged Accuracy files too.

**Interfaces:** Produces a combined baseline containing main's `preserveHumanLocks`, `withHumanEdit`, `writeClaimRow`, quadrant scoring and KAN4's `withAccuracyTransaction`, omission guards, events and experiments. No new feature contract.

- [ ] Create `KAN-83` worktree from KAN4; copy only the approved KAN-83 spec/plan. Merge refreshed main into this feature worktree. This brings the baseline the approved design inspected into the final KAN4 integration; record both parent SHAs.
- [ ] Resolve conflicts by tracing both behaviours, retaining main's owner/AI-off gate and KAN4's applicable access/omission guard. Keep event recording and completeness hooks when combining extraction modules. Keep both additive schema sets. Follow main's `/admin/accuracy` routing and move KAN4 links/tests consistently. Replace removed tests with equivalent assertions in current suites where main changed ownership; do not discard their coverage.
- [ ] Run `npm ci` using the merged lockfile, then `npm run typecheck` and `npm test`. Expected: exit 0. Record pre-existing failures separately; no feature implementation until the combined baseline is understood. Check relevant auth and experiment tests explicitly if either path changed.
- [ ] Commit the reconciliation independently as `merge: reconcile main and KAN4 for KAN-83`. Review it independently before feature work.

### Task 2: Structured, evidence-backed gap and inventory facts

**Files:** Create `src/accuracy/domain/structured-fields.ts`; modify need/inventory `module.ts` and `prompts.ts`, `claim-store.ts`, `claim-edit.ts`, `src/lib/iegp/enums.ts` only to map existing vocabulary, and extraction persistence consumers including `experiments/extraction-pipeline.ts` and omission recovery. Tests: `accuracy-need-extract`, `accuracy-inventory-extract`, main's `manual-accuracy-edits`, new `tests/accuracy-structured-fields.test.ts`.

**Interfaces:** Export `StructuredField<T> = {state:"known";value:T;provenance:ProvenanceSpan[]} | {state:"unknown";value:null;reason:string;provenance:[]}`; `GapStructuredFields`, `TacticStructuredFields`, and `readStructuredFields(claim: AccuracyClaimRow): GapStructuredFields | TacticStructuredFields`. Output records add versioned `structured` fields. Inventory lifecycle accepts `unknown` explicitly; normalized status inputs treat it as noncommitted.

- [ ] Add failing behavioural tests for known fields with valid spans, unknown owner/timing, unattributed speaker, unresolved document, old claims, invalid field quote, wrong source and ideation exclusion. Use Arrange/Act/Assert: prepare source blocks, extract/read a record, check stored values and evidence.

```ts
expect(readStructuredFields(legacyTactic).owner).toEqual({
  state: "unknown", value: null, reason: "legacy_missing", provenance: [],
});
expect(unknownLifecycleTactic.status).toBe("unknown");
expect(rejectedCandidate.reason).toBe("quote_not_substring");
```

- [ ] Run `npx vitest run tests/accuracy-structured-fields.test.ts tests/accuracy-need-extract.test.ts tests/accuracy-inventory-extract.test.ts`; confirm failure on new assertions.
- [ ] Extend Zod schemas and prompts for gap description/indication/disease setting/category/rationale/documents/attributed quotes and tactic description/objective/owner/timing/outputs. Explicitly map all nine Jira evidence areas to existing evidence-domain values, preserving the source label if vocabulary is coarser. Validate known facts with existing `validateProvenance` against permitted original blocks. Reject/report invalid candidates; do not silently convert them to successful empty extraction. Unknown fields require reasons and no invented evidence.
- [ ] Persist these fields through production extraction, experiments and recovery. Extend existing human-edit field allowlists and `preserveHumanLocks`; nested structured fields need field-level lock handling. Keep old outputs/claims readable through normalization. Make fact changes invalidate dependent validation while preserving prior actor/rationale/history; use a factual revision token derived from decision inputs rather than `updated_at` (validation itself changes timestamps).
- [ ] Run affected tests and scoped lint. Commit `feat(kan-83): extract structured source-backed gap and tactic facts`.

### Task 3: Source paging, stable reruns and extraction resume

**Files:** Create `src/accuracy/domain/source-pages.ts`; extend `extraction-batch-store.ts`, `schema.ts`, extract route, need/inventory modules/prompts, source extract actions and experiment pipeline. Tests: new `accuracy-source-pages.test.ts`, existing extract API, omission resume and experiment pipeline suites.

**Interfaces:** `buildSourcePages(blocks: ParseBlock[], budget: number): SourcePage[]`, where pages contain original block IDs, slice offsets and deterministic identities. Persist source revision, declared selection, expected/processed/failed units and next cursor in extraction batch metadata. Extract API adds optional `cursor` and `block_ids`; response includes `source_progress` with selection scope, page status and upstream dropped units. Reruns upsert by workspace/source revision/type/source-backed identity and return the original claim ID.

- [ ] Test a source exceeding 40,000 characters and 80 blocks, one oversized block, selected-block scope, failed second page/resume, malformed response and same-revision rerun after human edit. Assert every source character is represented, quotes keep original offsets, incomplete pages do not declare completion, and successful pages/locked fields are retained.

```ts
expect(pages.flatMap(p => p.units).map(u => u.text).join("")).toBe(originalText);
expect(resumed.claim_ids).toEqual(firstSuccessfulClaimIds);
expect(progress.complete).toBe(false); // failed or malformed page remains
```

- [ ] Run new tests and observe failures. Remove silent prompt `.slice(0, 40_000)` and extract route's first-80 selection. Configure the prompt budget through existing environment/config conventions, validate bounds and reserve instruction overhead. Subdivide oversized blocks with original offsets; never pretend synthetic slice IDs are original parse blocks.
- [ ] Extend KAN4's applied-batch identity/resume owner rather than adding another downstream resume journal. Save accepted page results atomically, run models outside transactions, serialize source application, and expose failed pages for retry. Only mark an extraction batch eligible for downstream completion after all declared pages are accounted for; preserve omission pause semantics.
- [ ] Replace `currentBatch`'s one-run-per-kind invariant with declared page-run membership per kind and source revision. A page retry replaces only that page's failed attempt; completed page findings remain current members of the batch. Downstream merge/status journal stays batch-scoped and is eligible only when all required pages are successful and applicable omissions resolved. Route omission writes through the existing transaction context when invoking shared claim mutation helpers; a direct pooled transaction must not publish some writes outside the atomic operation.
- [ ] Use existing merge/source matching for cross-revision identities, not a new fuzzy matcher. Same-revision stable identity uses external ID when supplied, otherwise canonical source-backed entity identity; preserve distinct entities and report ambiguous identity rather than merging by statement alone. Use `preserveHumanLocks` on upsert; conflicting model facts remain reviewable suggestions.
- [ ] Run `npx vitest run tests/accuracy-source-pages.test.ts tests/accuracy-extract-api.test.ts tests/accuracy-omission-resume.test.ts tests/accuracy-experiment-pipeline.test.ts` plus impacted extractor suites. Commit `feat(kan-83): page and resume complete source extraction`.

### Task 4: Exhaustive, resumable gap × inventory assessment

**Files:** Modify `coverage-store.ts`, `coverage-queue.ts`, coverage decide schemas/module, `schema.ts`, coverage/assist routes, coverage queue/cards/forms, and `src/modules/stages/s4-kg-mapping/module.ts` for cap semantics. Add `tests/accuracy-coverage-pagination.test.ts`; extend queue/schema/assist tests.

**Interfaces:** `listCoveragePage({workspace_id,cursor?,page_size?}): Promise<{pairs:CoveragePair[];snapshot:string;next_cursor:string|null;progress:CoverageProgress}>`; canonical verdict `pending|full|partial|limited|not_relevant`. `listCoveragePairs` remains a compatibility wrapper that exhausts pages where callers need all rows. Pair revision stores factual gap/tactic revisions, actor/run provenance, evidence, validation and freshness. Writes require expected revisions; database uniqueness is workspace/gap/tactic.

- [ ] Add tests for 101+ pairs, 1,001 claims, fourth/unlinked relevant tactic, proposed inventory, excluded/retired/ideated records, saved not_relevant, Limited round trip, model omissions, changed snapshot, concurrent duplicate writes and rejected pair protection.

```ts
expect(allPages.flatMap(p => p.pairs)).toHaveLength(eligibleGaps * eligibleInventory);
expect(progress.pending + progress.assessed).toBe(progress.eligible_total);
expect(roundTrip.overall).toBe("limited");
expect(changedCursor.error.code).toBe("stale_snapshot");
```

- [ ] Run focused failing tests. Enumerate deterministic eligible IDs without fixed 500-claim, top-three or 80-pair omissions; page responses without limiting the universe. Bind cursor to entity IDs/factual revisions; reject changed snapshots with an actionable restart. Ranking can order assessment; S4's per-gap cap cannot suppress assessment completeness.
- [ ] Extend the single coverage persistence owner. Migrate legacy aliases (`covers`→full, `none`→not_relevant, `unknown`→pending); retain human decisions and mark legacy missing revision freshness unknown. Resolve duplicate legacy pairs deterministically without losing human history before adding uniqueness. Never manufacture accepted evidence or not_relevant from a rejection alone.
- [ ] Return assessment and validation completeness independently, pending/stale/failure/exclusion counts and reasons. Resume only failed/pending pairs; successful same-revision/human decisions are protected. Assist remains a suggestion; manual confirmation validates permitted evidence and revisions before setting validated. Retain explicit not_relevant without forcing a supporting tactic link.
- [ ] Run coverage tests and scoped lint. Commit `feat(kan-83): assess every eligible inventory pair with paging`.

### Task 5: One shared lifecycle and freshness status rule

**Files:** Create `src/lib/iegp/coverage-status.ts`; modify Accuracy status engine/module, `src/lib/iegp/engine.ts` and actual status callers in store/stages/views. Tests: existing Accuracy status/merge-status and IEGP engine suites; new shared-rule tests if existing suites cannot isolate it.

**Interfaces:** `computeCoverageStatus(rows: readonly StatusAssessment[]): "open"|"partial"|"addressed"`; normalized row has overall, lifecycle, validated and current freshness. Accuracy and plan adapters map their inputs/output vocabulary. Effective human override remains separate from computed status.

- [ ] Add a table-driven test: proposed publication with evidence→Open; cancelled/unknown→Open; committed current validated Full plus Limited→Addressed; multiple Partial→Partial; only stale/unknown freshness→Open; rejected/pending→Open. Run the same scenarios through both adapters.

```ts
expect(computeCoverageStatus([fullPlanned, limitedOngoing])).toBe("addressed");
expect(computeCoverageStatus([fullProposedPublication])).toBe("open");
expect(computeCoverageStatus([partialPlanned, partialCompleted])).toBe("partial");
```

- [ ] Run failing tests, then implement the pure rule once. Remove proposed-publication contribution while retaining `isPublishedLiterature` for evidence display. Current validated Full dominates; no score summation or coverage-fraction threshold substitutes for Full. Unknown legacy freshness requires revalidation.
- [ ] Trace optional-tactics overloads, accepted-child shortcuts, residual drafting and all computed-status callers. Supply actual lifecycle/current validation; child existence alone cannot prove Full. Preserve draft mapping previews separately from authoritative validated status. Label planned coverage as plan coverage in existing status UI.
- [ ] Preserve override actor/rationale and stale markers; do not let stale effective overrides qualify split/priority inputs. Run impacted status/residual/S6 tests. Commit `fix(kan-83): unify validated plan coverage status`.

### Task 6: Confirmed atomic split, version record and rollback

**Files:** Replace Accuracy split stub in `partial-split/module.ts`; create `store/partial-split-store.ts`; extend `claim-store.ts`, `claim-edit.ts`, `schema.ts`, workspace table-copy/cleanup owners; add split proposal/apply/rollback Accuracy routes under existing request/auth helpers. Reuse S6's proposal domain semantics from `src/modules/stages/s6-partial-split/module.ts` without calling sequential cross-store persistence. Tests: new `accuracy-partial-split.test.ts` and `accuracy-partial-split-api.test.ts`.

**Interfaces:** `proposeAccuracySplit({workspace_id,gap_id}, ctx): Promise<SplitProposal>`; `applyAccuracySplit({workspace_id,proposal,operation_key,actor,rationale}): Promise<{addressed_gap_id,open_residual_gap_id,operation_id}>`; `rollbackAccuracySplit({workspace_id,operation_id,actor,rationale}): Promise<void>`. Proposal includes statements, slice-support tactic IDs, dimensions, evidence, parent/coverage revisions. Persist one operation snapshot and lineage record, extending existing edit-history action types for split/rollback.

- [ ] Test real children, nonempty distinct residual, unsupported slice refusal, wrong workspace, unconfirmed model proposal, stale input, exact evidence inheritance, residual pending coverage and no inherited priority. Inject failure between child writes; assert no visible children/retired parent. Test duplicate apply returns identical IDs, competing operation conflicts, rollback restores parent snapshot and later human edits block rollback.

```ts
expect(retry.addressed_gap_id).toBe(first.addressed_gap_id);
expect(residual.coverage.every(c => !c.validated)).toBe(true);
expect(afterFailedApply).toEqual(beforeApply);
expect(afterRollback.parent).toEqual(preSplitParent);
```

- [ ] Run failing tests. Generate proposals outside transactions. Apply only with authenticated rationale and currently validated Partial parent, unchanged factual/coverage revisions and committed evidence for the addressed slice. Recheck under a row/advisory lock inside `withAccuracyTransaction`.
- [ ] Atomically create children, references, explicit validated addressed-slice coverage, residual pending work, lineage/version record and parent retirement. Distinguish inherited context from direct statement evidence. Use `withHumanEdit` and existing claim history conventions; add operation snapshots only for this split, not a general replacement history store. KAN-36's general history files are not on either required baseline and remain its owner's responsibility.
- [ ] Rollback is an authenticated atomic inverse using the recorded snapshot; retire derived children/decisions and preserve the operation audit. Refuse later descendant/human edits, including coverage and priority edits. Integrate new tables into workspace cloning/deletion so experiments remain isolated.
- [ ] Run split tests plus experiment-copy and claim-edit/merge regressions. Commit `feat(kan-83): persist and roll back confirmed residual splits`.

### Task 7: Reuse S8 scoring with workspace-safe Accuracy placements

**Files:** Extract fitting pure scoring/validation functions from S8 `module.ts` into `scoring.ts`; reuse `axes.ts`/`axis-math.ts`; create `src/accuracy/store/priority-store.ts`; replace Accuracy priority stub; extend priority route/manual validation, schema and copy/cleanup support. Tests: S8 suites and new `accuracy-prioritization.test.ts`, `accuracy-priority-api.test.ts`.

**Interfaces:** Shared S8 suggestion function consumes gap/context/axis data without `loadState()` and returns finite 0–100 axis scores, quadrant band, rationale and evidence limitations. Accuracy placement key is workspace/gap. Output includes `axis_scores`, configuration/input revisions, `suggested_band`, working `band`, validation/freshness, rationale/references and skipped reasons; preserve `defer`. Manual set/validate reuses S8 input validation/lock rules.

- [ ] Test identical configured input gives identical S8/Accuracy scores/bands, reversed cost axis and Defer, missing context, nonfinite model scores, Open eligibility, stale override exclusion, wrong workspace, manual operation with AI off, dry run, human score/band protection, config/input invalidation and concurrent rerun.

```ts
expect(accuracy.suggested_band).toBe(s8.suggested_band);
expect(quadrantBand(unfavourableBoth)).toBe("defer");
expect(rerun.working.axis_scores).toEqual(humanScores);
expect(afterConfigChange.validation.freshness).toBe("stale");
```

- [ ] Run failing tests. Extract existing S8 scoring without changing customer scoring semantics. Load saved configuration through its existing workspace context. Accuracy adapter reads its own active currently human-validated Open claims/residuals; never passes their IDs directly into customer `loadState()` or unscoped placement tables.
- [ ] Build context with strategic fit, clinical/patient impact, payer relevance, guideline evidence, unmet need, competition and feasibility, each supported or explicitly missing. Unsupported model values remain suggestions with limitations; validate score bounds/finiteness. Preserve S8 axis direction/quadrants and suggestion vs working decision.
- [ ] Persist through workspace-owned Accuracy placement table. Protect human axes/bands on rerun; changed decision/config inputs mark stale without deleting prior actor/rationale. Manual operation requires no model. Preserve legacy mirror code; KAN-17 retirement stays separate. Extend experiment copy/cleanup for placements.
- [ ] Run new priority and existing S8 tests, typecheck and scoped lint. Commit `feat(kan-83): adapt authoritative S8 priorities to Accuracy`.

### Task 8: Connect the existing workflow and prove final integration

**Files:** Extend existing admin Accuracy ledger claim card/fields, source actions, coverage queue/card/form and API helper components; add split confirmation/rollback and priority controls beside existing actions. Add `e2e/accuracy/kan83-stage-completion.spec.ts` with existing support helpers; extend existing feature S6/S8 specs where changed status applies. Update approved spec status and user-facing workflow documentation.

**Interfaces:** UI consumes Tasks 2–7 APIs; no parallel calculation. Source progress, pair assessment/validation progress, evidence, unknowns, computed/effective status, split preview/confirmation/history and priority suggestion/working decision are visible.

- [x] Add browser assertions for fresh workspace upload→structured gap/inventory→all pairs/paging→manual validation/status→split preview/confirm→residual priority/manual validation→rollback. Seed deterministic model responses through existing test harness, not production fallback. Include a fourth relevant tactic and >80 pairs, keyboard-accessible controls and clear failure/resume state.
- [x] Extend existing components and preserve layout/accessibility. Unknown facts show their reason, source evidence opens existing provenance, pending/limited remain distinct, totals reflect the snapshot, and AI failure leaves manual work possible. Confirmation displays the exact addressed/residual statements and evidence before apply.
- [x] Run affected Vitest suites; `npm run typecheck`; scoped `npx eslint` on changed TS/TSX; `npx playwright test e2e/accuracy/kan83-stage-completion.spec.ts e2e/features/s6-partial-split.spec.ts e2e/features/s8-prioritization.spec.ts`. Expected: exit 0. Also run experiment isolation/omission regressions and the smallest customer extraction/mapping suites affected by shared rules.
- [ ] Independently review the whole branch against the spec, settle findings and rerun only affected checks. Record fixture/live-provider limits honestly.
- [ ] Commit documentation/tests, merge reviewed KAN-83 into KAN4 while preserving unrelated dirty files (use a separate integration worktree if needed), and run the same required integration checks on the merged SHA. Publish both branches to both remotes using `scripts/push-both.sh`; verify remote SHAs.
- [ ] Post Jira implementation/verification/limitations comment and transition KAN-83 to Done only after all required proof passes. Fetch next assigned Ready/To Do issue and arm the required handoff only after successful Done, using the lifecycle helper.

## Controller self-review

Spec coverage: structured facts/vocabulary→Task 2; source completeness/reruns→Task 3; exhaustive assessment/provenance/freshness→Task 4; status/lifecycle/overrides→Task 5; atomic split/history/rollback→Task 6; S8/manual locks/configuration→Task 7; display/browser proof/integration→Task 8. Task 1 explicitly covers the baseline incompatibility discovered after the user chose KAN4 as the target.

The interface sequence is deliberate: structured factual revisions feed page upserts, assessment snapshots, shared status, split checks and priority freshness. Existing timestamp changes are not factual revisions. No task claims a nonexistent Accuracy general history owner; split extends the actual claim-edit audit convention. All five Review Focus cases have tests in their owning tasks. Any implementation-level signature refinement must be recorded in the SDD ledger and carried into the next task brief.

Execution checkpoint: isolated task implementation and Task 8 scoped proof are recorded in the SDD task reports. Whole-branch independent review, merged-SHA checks, publication and Jira lifecycle remain controller work; the unchecked Task 8 steps above are not completed by the worker.
