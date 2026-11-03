# KAN-206 cost controls implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Give the owner auditable conservative experiment spending controls and distinct cost evidence.
**Architecture:** Extend existing raw-call dispatch checkpoints with an execution-scoped durable cost account and reservations. UI consumes owner-only API summaries; no shared settings changes.
**Tech Stack:** Next.js 16, TypeScript, Zod, Drizzle/PostgreSQL, Vitest, Playwright.
**Spec:** docs/superpowers/specs/2026-10-30-kan-206-cost-controls.md

## Global Constraints
- Owner-only Development; no paid experiments or shared/customer configuration changes.
- Unknown pricing remains null, never zero; no strict ceiling promise for unknown/in-flight charges.
- Atomic conservative known-price reservations before every generation/evaluation send; no oversubscription.
- Preserve immutable manifests, completed work and no automatic uncertain resends; HTTP max attempts remains one.
- Estimated, generation usage, evaluation usage and manually reported execution totals stay distinct; no invented section allocation.
- Actor/time audit for acknowledgments, increase/override/resume, retry policy and spend corrections.
- Finite nonnegative amount, validated currency; no credentials in history or errors.
- Follow Next.js bundled documentation, targeted tests, npx tsc --noEmit and applicable lint.

## Review Focus
- Concurrent generation and evaluation reservations cannot oversubscribe one execution allowance.
- Unknown models and partial/missing usage must stay unknown across every contract.
- Budget pause must preserve replay-safe requests and section/evaluation output and resume without duplicate send.
- Foreign experiment IDs and invalid spend inputs must fail before writes.
- Historical records without cost data remain readable; reported corrections append, never rewrite evidence.

### Task 1: Durable cost controls and owner API

**Files:** Create src/modules/development/cost.ts, cost-store.ts and cost-schema.ts; extend execution/evaluation schemas, stores, starts and workers; add owner cost estimate/account routes under src/app/api/admin/development/[id]; tests/kan-206-costs.test.ts and tests/kan-206-cost-api.test.ts.
**Interfaces:** Produce documented serializable estimate/account summary types and owner endpoints for preview, read, spending actions and reported corrections. Both workers use the same execution-scoped atomic reservation API. Pass authenticated actor from guarded handlers; never accept client actor.

- [ ] Write and run failing happy/error tests for exact/unknown pricing, all categories, finite amount/currency, concurrency, pause/increase/override/resume, bounded retries and correction audit.
- [ ] Implement pure calculations with exact price matching and explicit uncertainty; avoid modifying shared pricing behavior. Conservative actual raw request token upper bounds must account for UTF-8 and provider overhead; if a trustworthy bound cannot be established treat as unknown and require acknowledgment.
- [ ] Add additive transaction-safe storage for execution account, reservations and append-only events/reported history. Integrate at send boundary, retaining active reservations for uncertain sends and releasing only with sound settlement evidence. Paused jobs must be skipped by automatic worker claims and explicitly resumed after allowance action. Resume must not bypass code identity, lease, AI or uncertain-send safety.
- [ ] Add owner API preview and read/action routes; start requests carry cost controls with backwards-compatible safe defaults (missing controls must pause before spending, never silently authorize unknown charges). Cover evaluation-only/re-evaluation and Run All/section reruns.
- [ ] Expose durable summaries in execution/evaluation/history contracts and record known usage with pricing provenance separately for generation/evaluation. Preserve older records and tests.
- [ ] Run npx vitest run tests/kan-206-costs.test.ts tests/kan-206-cost-api.test.ts and development regression files, npx tsc --noEmit, targeted eslint. Record exit codes and any baseline failure. Do not commit: controller owns git/PR operations.

### Task 2: Development spending UI and browser proof

**Files:** src/components/development/development-execution.tsx, development-evaluation.tsx, a focused development-costs.tsx component; e2e/features/development-costs.spec.ts; relevant UI contract tests.
**Interfaces:** Consume Task 1 documented API/types; keep generation/evaluator config independent of spending controls.

- [ ] Add targeted failing UI/browser checks for estimates, unknown acknowledgment, paused allowance actions, invalid spend and correction history, distinct estimated/usage/reported values.
- [ ] Extend existing forms with labeled editable USD allowance, explicit current-execution unknown acknowledgment, pre-run preview, and allowance increase/override/resume actions. Include re-evaluation spending controls and existing execution selection. Preserve outputs and display pauses clearly.
- [ ] Display separate generation/evaluation known usage, uncertainty and optional reported total with currency/correction history. State reported totals are owner reports, not verified provider billing; never invent section allocations.
- [ ] Use existing visual conventions and accessible labels/feedback; read impeccable/uncodixfy and bundled Next.js UI docs. No redesign.
- [ ] Run targeted Playwright with isolated test persistence and temporary server; stop owned servers. Run targeted development tests, npx tsc --noEmit and applicable lint. Record exact results. Do not commit.

## Implementation verification and review

Both task reviews and the final scoped correction review approved requirement compliance and code quality. Final review found a receipt/accounting interruption gap; workers now reconcile accounting from saved provider evidence before replay/publication. Temporary ledger failures preserve claimable work. The recovery matrix proves exactly one provider send and idempotent accounting for generation/evaluation success/failure evidence across transient errors and expired leases, including paused accounts.

- Full Vitest before final correction: 2730 passed, 10 skipped; 250 passed files / 1 skipped.
- Final affected backend suite: `DATABASE_URL=<isolated PostgreSQL> npx vitest run tests/kan-206-costs.test.ts tests/kan-206-cost-api.test.ts tests/kan-202-execution.test.ts tests/kan-204-evaluations.test.ts` — 82 passed.
- Final recovery matrix: `npx vitest run tests/kan-206-cost-api.test.ts -t 'recovers .* saved accounting'` against isolated PostgreSQL — 8 passed, after 8 failures before the fix. Controller independently confirmed 8 passing cases.
- Final changed browser specs: 24 passed; broader affected browser suite previously 42 passed.
- Final `npx tsc --noEmit`, changed-file ESLint and `git diff --check` passed. Full lint passed with 16 existing warnings.
- No paid model calls; provider stubs and isolated PostgreSQL only.

Material limits: actual provider request/billing ceilings remain unknown; explicit acknowledgment is required and cannot guarantee a cap. Owner-reported totals remain unverified execution totals. Failed/uncertain calls retain active reservations and cannot be automatically resent. Code changes still block old-manifest replay. No reopening of already-terminal historical work is introduced. Nonblocking final review M2 is deferred: the generation preview defaults to one section without identifying that scope, while Run All saves a four-section estimate.

Decisions: native subagents use the bounded ownership/report/verification contract instead of launching a second CLI; proceed under ticket authorization without an additional design approval; target KAN-200 per the ticket-specific integration workflow. The PR remains open and merging is separate.
