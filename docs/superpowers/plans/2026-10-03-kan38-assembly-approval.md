# KAN-38 Assembly Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Require authorized approval of exact complete checked proposals before live use.
**Architecture:** Append immutable review decisions to existing assemblies; resolve approved per-source/per-kind production heads into the existing claim/coverage interfaces; enforce consumption in the kernel and direct boundaries. Trusted internal preparation/experiment scopes use AsyncLocalStorage rather than request flags.
**Tech Stack:** TypeScript, Next.js 16.3.5, React, Drizzle/PostgreSQL, Vitest.
**Spec:** docs/superpowers/specs/2026-10-03-kan38-assembly-approval-design.md

## Global Constraints

- Reviewer identity and role come from authenticated server sessions. Only contributor and medical_affairs can review.
- Require nonblank rationale for approval/rejection and explicit reason for every advisory override. Blocking deterministic findings cannot be overridden.
- Bind review to exact assembly ID, fingerprint and check report. Reject stale production heads and never substitute an older approved proposal.
- Resolve current applied production batch heads per source/extraction kind; a one-kind batch does not erase the other kind. Missing or incomplete assemblies pause.
- Experiments and automatic extraction/linking are isolated trusted internal scopes; HTTP input cannot choose bypass.
- Selected content/evidence and links come from immutable assemblies; workflow overlays cannot replace selected content.
- Keep KAN-39 additions/removals/editor out of scope. Preserve original checkout edits.
- Read installed Next.js guides before route/component edits. Use existing UI primitives and visual style.
- Use test-first Vitest. Implementation workers do not spawn agents or push. Controller commits/publishes both remotes.

## Review Focus

- A newer applied batch without an assembly must pause instead of falling back (Task 1).
- Gap-only publication retains the approved tactic head (Task 1).
- Caller-supplied explicit IDs/payloads cannot bypass exact approved inventory (Task 2).
- Approval/publication races cannot publish a result using stale heads (Tasks 1/2).
- UI competing reviews and workspace switch cannot show approval of the wrong proposal (Task 3).

### Task 1: Review storage and approved live inventory

**Files:** Create src/accuracy/domain/assembly-review.ts, src/accuracy/store/assembly-review-store.ts, src/accuracy/kernel/assembly-context.ts; modify schema.ts, tenant.ts, assembly-store.ts only as needed; tests/accuracy-assembly-review-store.test.ts, tests/accuracy-assembly-review.test.ts. Reuse /private/tmp/kan38-trace.md.
**Interfaces:** Export AssemblyReviewError with invalid_input/not_found/conflict/forbidden/approval_required codes; AssemblyReview records reviewer subject/provider/actor/role, assembly_id, fingerprint, checks fingerprint, decision, rationale, override reasons, created_at. Export reviewAssembly({workspace_id,assembly_id,expected_fingerprint,decision,rationale,advisory_overrides,reviewer}), assemblyReviewState(workspace_id,assembly_id), approvedLiveInventory(workspace_id) returning null for legacy or {claims,coverage,bindings} for managed approved heads. Export withAssemblyPreparation(operation), withAssemblyExperiment(operation), assemblyExecutionScope() internal AsyncLocalStorage scope; approval inventory never accepts HTTP bypass flags. Export a reusable lock helper and consumed-head revalidation helper for Task 2. Confirm exact interface definitions in report; Task 2 uses exported types.

- [ ] Write pure review policy and DB tests first; record expected failures. Tests must prove signed role policy, whitespace rationale, blocking checks, explicit advisory reasons, exact fingerprint/report binding, tampered persisted output, production/experiment discrimination including empty assemblies, current applied batches with absent proposal, rejection/no fallback, stale review request, gap-only head retention, exact earlier payload projection/canonical links, workspace isolation, concurrent review and batch publication, cleanup.
- [ ] Add append-only review schema/DDL/migrations and cleanup. Use existing workspace advisory transaction lock. Review rechecks current evidence and binds exact body/report; competing approval/rejection requests supply current decision identity or refuse duplicates/conflicts deterministically.
- [ ] Resolve production heads using successful persisted extraction runs and applied batch records; do not treat unknown/corrupt experiment metadata as production. Select each current source/kind head deterministically; resolve assembly via generation_key=batch.id. Manual KAN-37 assemblies without batch may be reviewed only if safe explicit lineage; never promote them as implicit production head.
- [ ] Project exact selected items/coverage to claim-shaped inventory, scoped to current extraction kinds. Preserve safe workflow overlays without leaking draft content. Fail closed on ambiguous/conflicting heads. Approval counts as selected-item validation. Include binding IDs for all consumed heads/reviews.
- [ ] Run focused tests and typecheck; self-review; write full report with RED/GREEN commands/results and exported interfaces. Leave changes uncommitted for controller.

### Task 2: Enforce approved consumption and authenticated review API

**Files:** Modify claim-store.ts, coverage-store.ts, kernel/run.ts, assembly-generation.ts, extraction pipeline/route, experiments as needed; add review POST support to assemblies route; direct consumer routes/stores (ideate, coverage/assist, gantt/save-final, workshop/actions/tags, claims priority/validate, review, plan) as traced; tests/accuracy-assembly-approval-integration.test.ts and API tests; update existing tests affected by intentional gate.
**Interfaces:** Consume Task 1 approvedLiveInventory, reviewAssembly, assemblyReviewState, trusted scope helpers, binding revalidation and lock helper. Extend GET assembly response with review metadata/can_review without replacing immutable assembly body. POST strict {workspace_id,assembly_id,expected_fingerprint,decision,rationale,advisory_overrides,expected_review_id?}; reviewer is derived from session, with authorized workspace grant. Record consumed bindings in module run evidence/output metadata.

- [ ] Write failing integration/API tests proving authenticated role/tenant enforcement, malformed/unknown fields, stale decision 409, exact approved earlier payload consumed, no output/run/write before approval or after rejection/new publication, explicit IDs and payload bypass refusal, automatic generation before human, isolated experiment unaffected, revalidation rollback when heads change during provider execution.
- [ ] Route production live inventory readers through approved projection. Separate raw source-completeness/generation reads so preparation does not deadlock on approval. Explicit live reads resolve from approved projection and require membership. Validate supplied module payloads against approved inventory; use existing persisted approved inputs where possible, reject incompatible supplied inputs.
- [ ] Apply exhaustive call-kind approval policy in runAccuracyModule and direct downstream boundaries. Internal generation uses a trusted scope; HTTP generation_context/selected_versions never grants bypass. Wrap extraction merge/status/linking and experiment paths in their correct internal scope. Preserve independent omission checks.
- [ ] Protect durable writes with workspace lock and current binding revalidation. Provider calls may run outside lock; publish effects and close successful run only if consumed heads remain current. Block unsupported content/coverage changes with clear revision-required conflict; allow documented workflow overlays only. Legacy no-applied-batch behavior remains compatible.
- [ ] Add authenticated strict review API and authorized GET review status. Return typed generic errors with appropriate 401/403/404/409/400/500, server logging for unexpected errors. Run focused affected tests/typecheck; self-review; report RED/GREEN and exact modified routes. Leave uncommitted for controller.

### Task 3: Complete proposal review UI and final verification

**Files:** Modify components/accuracy/assembly-history.tsx; optionally new assembly-review-controls.tsx; ledger page copy only where needed; tests/accuracy-assembly-review-ui.test.ts; docs/kan-38-assembly-approval.md.
**Interfaces:** Use Task 2 GET review metadata/can_review and POST decision schema. Always send exact displayed fingerprint and expected review identity; refresh list/detail after decision; never optimistic approve before server acceptance.

- [ ] Write failing DOM tests for approved/rejected/pending/stale labels, viewer restriction, rationale required, blocking checks disable approval, every advisory acknowledgement/reason, exact request binding, error/retry and concurrent review conflict, workspace switch/StrictMode request isolation.
- [ ] Add accessible conventional labeled form to complete proposal inspector. Show reviewer/time/rationale/overrides, live head status, blocking/advisory findings. Approval/rejection only after complete proposal loaded. Keep additions/removals out of scope; explain rejection pause and required revised proposal in plain product language.
- [ ] Document what changed and how to verify; run focused UI tests, full npm test, npm run typecheck, changed-file ESLint, git diff --check, recording commands/results. Fix regressions in owned implementation or report cross-task concerns; no broad unrelated refactor. Write report; leave uncommitted for controller.
