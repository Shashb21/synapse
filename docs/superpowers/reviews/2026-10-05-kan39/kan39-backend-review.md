# KAN-39 Task 1 fresh backend review

## Verdicts

- **Specification compliance: changes required.** One Important finding prevents acceptance: review-current checks and live inventory disagree after a new extraction takes ownership of an opposite kind introduced by a human revision.
- **Code quality: changes required.** The same finding is a correctness defect in shared approval enforcement. The rest of the inspected implementation has a coherent separation between immutable history, mutable head pointers, provider work, and approval projection. No additional independently established Critical or Important defects were found.

## Important finding F1 — live inventory accepts a human revision that the review path marks stale

**Responsible locations:** `src/accuracy/store/assembly-review-store.ts:499`–`507` (`assemblyForHead`), and `src/accuracy/store/assembly-review-store.ts:533`–`545` (`projectedItems`). The conflicting current-head rule is at `src/accuracy/store/assembly-review-store.ts:285`–`287`.

**Concrete triggering sequence:**

1. Publish a complete tactic-only production extraction batch for source S and its baseline B.
2. Add a source-backed gap G through `createAssemblyRevision`. There is no current `need_extract` owner for S, so the addition is accepted and relinked to B's tactic. Approve the resulting complete revision R. Both G and the tactic appear in live inventory.
3. Publish a separate need-only production extraction batch for S, with a valid complete assembly N, and approve N. Use a gap payload with a different canonical identity from G so there is no accidental canonical collision. B remains the current tactic extraction owner; N is now the current need extraction owner.
4. Inspect R with `assemblyReviewState`, then call `approvedLiveInventory` or `listDownstreamClaims`.

**Actual behavior established by the code paths:**

- `assemblyCurrentForDeclaredProductionRuns(R)` sees the new need counterpart, which R does not cover, and returns false at lines 285–287. R is therefore reported stale, and it cannot receive another approval or content revision.
- `assemblyForHead` follows B's revision pointer to R but only checks its saved body, complete/passing checks, the tactic head it covers, and its prior exact approval. It never applies that same current-production rule.
- `projectedItems` excludes G because a need head now exists. The intended conflict branch at lines 540–544 cannot catch this: an opposite-kind item enters `projectedItems` only when no counterpart head exists, so `counterpart` is necessarily absent for those items.
- Inventory can consequently return N's gap and R's tactic, silently discarding the approved human-added G. Its coverage/mapping loops also skip G's pairs because G is no longer selected. An edited tactic can demonstrate the additional impact: add G, then edit the tactic and approve the latest revision before step 3; the tactic edit is still served from the stale human revision.
- `revalidateApprovedLiveBindings` rebuilds inventory through this same path. A module started after step 3 can consume this stale revision and pass publication revalidation if no further state changes occur. A module started before step 3 still conflicts due to the changed bindings; the existing race test therefore does not cover this defect.

**Why this matters:** The specification requires the current revision head to agree across review, approved inventory, and publication revalidation, and requires incompatible overlapping production ownership to fail closed. Silently projecting a subset changes the reviewed successor and allows a revision that the application itself marks stale to authorize downstream work.

**Recommended correction:** Before projecting a human revision for a current extraction head, enforce the same production-current/ownership rules used by the review path. In particular, detect the new counterpart owner before filtering any human item out. Return the established approval/conflict error instead of silently replacing the human selection. Preserve any deliberate legacy/generated-assembly projection behavior separately if the existing KAN-38 tests depend on partial extraction scopes.

**How to verify:** Add a focused integration test following the sequence above (and its symmetric gap-only → human tactic → new tactic-only owner case). Assert that R becomes stale and both `approvedLiveInventory` and `listDownstreamClaims` refuse the incompatible projection after N is approved. Assert publication cannot proceed using R, including a module started after the ownership change. Keep the existing one-kind addition success test and the test rejecting a counterpart that already exists when the addition is attempted. They cover different points in the ownership lifecycle.

## Other requirements inspected

The following findings are satisfactory within this read-only review and the supplied verification evidence:

- Human versions use explicit `human_origin`, a null run/snapshot/iteration, and session-owned author fields. Generated versions retain their extraction run, snapshot/final-output checks, and organization/source checks.
- Add/edit/remove schemas require a trimmed nonempty reason and reject unknown content/action/outer request fields. Server lookup confines edits/removals to selected version IDs; edits retain type/source and canonical identity; additions get server IDs and a history-only backing claim.
- Baseline assembly rows, original extraction outputs, and evaluator scores are preserved. Removal changes successor selections and pair links, with immutable change history retained.
- Revision creation, lineage, initial assembly, and head publication share the workspace transaction/lock. Expected fingerprint/head and current production checks reject stale parents, sibling publication, experiment targets, and stale completion after extraction changes.
- Coverage calls execute outside the initial/publication transactions. Stable exact-pair run identities reuse successes; unchanged decisions are retained; edited/removed endpoint decisions are excluded from the successor. Provider failures save an incomplete head and append-only attempt; retry keeps the same action/revision identity and successful pairs.
- New successors require exact fresh approval; the original baseline pointer cannot restore eligibility. Incomplete/blocked successors remain inspectable and block ordinary approval/live use.
- Authorized workspace reads and contributor-only mutations use the session subject/provider/actor, with Medical Affairs approval retained. Invalid JSON/schema/content, missing scope, and conflicts use the intended response classes; unexpected failures are logged with generic external errors.
- Schema declarations and migration SQL agree for the origin/revision/head/attempt fields. Tenant cleanup removes heads/attempts/revisions before assembly and item-version targets.

## Evidence and limits

Reviewed the complete supplied diff/new-file package, Task 1 plan, design specification, review focus, backend report, and relevant current store/kernel/API/schema and existing runner/transaction/quote-validation code. This was an independent code-path review; no repository files, Git state, or Jira state were changed, and no agents were spawned.

As requested, unchanged tests were not rerun. Accepted the supplied evidence of 167 distinct backend tests, typecheck, changed-file lint, and `git diff --check`. Existing tests exercise initial opposite-kind projection and rejection when another owner already exists, but do not exercise an owner appearing after a human revision has been approved. F1 is established by the explicit branch conditions above; a new focused regression should execute the sequence as part of the correction.

Provider evidence is deterministic; frontend/browser UX, real provider execution, crash recovery of persisted running provider attempts, and large-history performance remain outside the proof supplied for Task 1. The report explicitly identifies the existing 20-attempt bound and running-attempt recovery limit; these were not promoted to separate findings without an additional task-specific requirement or independently demonstrated regression.
