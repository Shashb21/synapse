# KAN-183: Extracted evidence integrity

## Spec and design
Authority: https://synapse21.atlassian.net/browse/KAN-183 (fetched 2026-10-27).
A claim's supporting quote must exist in its stated parse block, belonging to the same source and workspace. Claims and relational provenance must commit together. Source editing must protect historic metadata-only citations too.
Reuse `quote-validator.ts`, the existing claim store, and parse-store guards. Reject invalid evidence before insertion; never silently repair a foreign source/workspace ID. Keep metadata for existing readers. Historic valid metadata spans should be reconciled safely and idempotently; malformed or unverifiable historic evidence must not be converted into trusted provenance, silently erased, or allow destructive edits past an unresolved reference. Prefer reconciliation scoped to affected blocks/claims over whole-database migrations. Manual claims without citations remain supported.
Alternatives considered: route-only validation would leave store callers unsafe; a new evidence service would duplicate ownership. Extend the stores and existing extraction judge instead.

## Global Constraints
- Reject fabricated quotes and cross-block/source/workspace binding.
- Persist a claim and its relational provenance in one database transaction.
- Preserve existing manual claims and metadata consumers.
- Protect cited text edits/deletions; permit unrelated valid edits.
- Reconcile historic metadata-only citations safely and idempotently, including split/merge guard paths.
- Use this TypeScript repository's Vitest/database tests and browser tests where relevant.
- Keep unrelated working-tree changes untouched. No credentials in logs or commits.

### Task 1: Validate extraction and make provenance durable

**Files:**
- Modify: `src/accuracy/store/quote-validator.ts`, `src/accuracy/store/claim-store.ts`, `src/accuracy/store/parse-store.ts` as needed.
- Modify: `src/accuracy/modules/need-extract/module.ts`, `src/accuracy/modules/inventory-extract/module.ts`, `src/app/api/accuracy/extract/route.ts` as needed.
- Test: existing quote/extract tests and a focused `tests/kan-183-provenance.test.ts` database regression suite.

**Interfaces:**
- Consumes existing `validateProvenance`, `insertClaim`, parse-block edit/delete/split/merge operations, and metadata.provenance span shape.
- Produces the same public claim/extraction output shapes, with evidence validated against actual blocks and relational rows saved atomically. Prefer extending insertClaim so all callers with metadata.provenance receive the invariant.

1. Trace the current quote validator, extraction critic/judge, claim insert, parse guards, and reparse paths. Read installed Next route docs before route changes.
2. Write and run failing Vitest tests first: schema-valid invented quote rejected; valid claim creates relational rows; one invalid span in a multi-span claim inserts neither claim nor provenance; foreign source/workspace/block rejected; no-citation manual claim allowed; metadata-only historic citation blocks destructive edit/delete and reconciles without duplicates; malformed historic spans stay protected without trusted backfill; valid edits preserving quotes succeed. Include module judge coverage for both extractors. Tests follow Arrange (prepare fixtures), Act (perform operation), Assert (check observable result).
3. Extend the responsible existing helpers/stores. Use specific validation errors and clear failure reporting, validate against current database text inside the persistence transaction, and retain quote whitespace compatibility in downstream guards. Check concurrent mutation risks: validation and commit must not race source changes. Use existing transaction/locking conventions if present; avoid expanding into unrelated source-edit refactors.
4. Run focused tests, TypeScript check, and lint. Run full Vitest once before completion; report pre-existing/environment failures separately and retain logs. Add browser test only if server contract cannot be sufficiently covered by existing API/database tests.
5. Self-review and write full report including RED/GREEN evidence, changed files, exact commands/results, and material limitations. Do not commit or push; controller owns git and PR operations.

## Review Focus
Invented but schema-valid quotes; workspace/source mismatches; all-or-nothing failure; historic invalid/missing spans; normalized whitespace and split/merge re-pointing; stale source edits during extraction.
