# KAN-39 whole-branch review

Reviewed base `bb35e95` through head `2bf2b75` in `/private/tmp/synapse-kan39-worktree`, using the complete branch diff, final production code and relevant existing consumers, approved design/plan, review focus, progress rulings, both task reports, and both correction/re-review packages.

**Specification compliance: CHANGES REQUIRED.** One Important integration finding remains: the existing per-item history presents human versions as judged model output.

**Code quality: CHANGES REQUIRED.** The new nullable run/human-origin contract is handled correctly in complete-proposal inspection but is not handled by its existing per-item history consumer. No other actionable Critical, Important, or Minor finding was established in this review.

## F1 — Important: display human origins in the existing Item history panel

**Changed integration location:** `src/accuracy/store/item-history-store.ts:138–140`, which now returns `human_origin` and nullable generated-origin fields to the existing history API.

**Affected rendering location:** `src/components/accuracy/claim-history.tsx:75–77` (existing code reached by this change); the panel is mounted by `ledger-claim-card.tsx:184`.

**Concrete trigger:** Start with an ordinary extracted gap/tactic visible in the Ledger. Save a reasoned human edit through Complete proposals. Open that claim's **Item history** panel (or reload it after the revision). `createAssemblyRevision` persists the human version under the same claim ID with `run_id`, `snapshot_id`, and `iteration` all null. `readItemHistory` returns it alongside the original model versions.

**Observed by code tracing:** ClaimHistory ignores `human_origin`. Its human row has a blank Run, `Snapshot: Judged final output (no snapshot)`, and `Iteration: Judged final output`. The contributor, reason, revision, and predecessor are absent. Thus this established provenance view labels the contributor's corrected payload as judged model output, despite the new complete-proposal panel displaying it correctly. The persisted model output and scores remain unchanged; this is a user-visible authorship/lineage regression, not score corruption.

**Required correction:** Branch this consumer on `version.human_origin`, showing an explicit human origin and the stored contributor/change/reason/revision/parent/predecessor. Apply the existing run/snapshot/iteration labels only to generated origins. Do not synthesize a run or snapshot for a human version.

**Verification:** Add a focused Item history UI case with a generated version and a later human edit belonging to the same claim. Assert the human row's author/reason/lineage and absence of “Judged final output” in that row; assert the generated row retains its real run and existing snapshot/final-output presentation. The existing item-history API already returns the needed origin.

## Integrated behavior assessed

- Reasoned add/edit/remove schemas, server-owned contributor identity, organization/workspace scoping, item membership, source-bound quotes, rollback, canonical identity preservation, and explicit human persistence.
- Immutable initial/failed/completed assemblies and revision lineage; retained unaffected coverage, removed obsolete endpoints, exact-version provider reuse, and publication checks after provider work outside the transaction.
- Workspace locking and fingerprint/current-head checks; old-baseline approval refusal, incomplete revision blocking, extraction supersession, one-kind human additions, competing ownership refusal, approved live projection, and downstream binding revalidation. Both previously reported Important corrections remain sound in the integrated code.
- Preservation of original extraction payloads and evaluator gold/model score records.
- Complete-proposal forms, retained payload fields/evidence spans, independent server permissions, announced loading/errors, stale authority invalidation, exact successor and baseline navigation, failed linking retry, and late workspace responses.
- Matching new schema/DDL and deletion ordering for revision dependencies.

## Evidence and limits

Accepted the task verification evidence without rerunning unchanged tests: backend covering run 73/73 (14 revision, 49 approval integration, 10 review store); frontend covering run 31/31 (18 revision, 8 review UI, 5 history UI); reported typecheck, scoped lint, and diff checks passed. The earlier frontend/API timeout did not reproduce in the reported unchanged rerun; its cause remains unknown.

The controller owns the current full Vitest run (`/private/tmp/kan39-full-vitest.log`); its final result was not yet supplied when this report was written. This review did not run tests, modify source, create subagents, or write git/Jira state. F1 follows directly from the new producer contract and the existing renderer; no browser reproduction is claimed. Browser layout/full assistive-technology behavior, real-provider accuracy, and large-history performance remain unverified as already documented.
