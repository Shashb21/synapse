# KAN-189 Unique Accuracy Plan Versions Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Execute the single integrated task test-first.

**Goal:** Concurrent Accuracy plan saves produce distinct consecutive versions, enforced by PostgreSQL, with deterministic readback and safe historical migration.
**Architecture:** Extend the existing Accuracy store transaction pattern. Serialize allocation and insertion with a transaction advisory lock keyed by Accuracy workspace, then enforce workspace/version uniqueness in schema and runtime migration.
**Tech Stack:** TypeScript, Drizzle, PostgreSQL, Vitest.
**Spec:** https://synapse21.atlassian.net/browse/KAN-189 (fetched 2026-10-29).

## Global Constraints

- Deterministic simultaneous saves allocate distinct consecutive versions within one workspace.
- A direct duplicate workspace/version insert is rejected by the database.
- Latest-plan readback is deterministic.
- Failure rolls back allocation/save safely, and migration preserves historic plans.
- Preserve all IDs, snapshots, audit metadata, and plan rows; migration may deterministically repair version numbers for affected workspaces.
- Use the shared Accuracy database transaction, not the unrelated IEGP workspace transaction router. Retain current public interfaces and note validation.
- No unrelated UI, provider, deployment, or tenant changes. Follow repository dual-remote rules; controller owns commits, pushes and PR.

## Review Focus

- Empty workspace simultaneous first saves must serialize, including with multiple database connections.
- Waiting saves must read the committed latest version after obtaining the lock.
- An insert failure releases the lock and does not consume a version.
- Old duplicates with tied timestamps must migrate deterministically without lost rows or mutated snapshots; unaffected workspaces retain version numbers.
- Multiple processes running startup migration must not interleave repair and constraint installation; migration must be atomic, idempotent and retryable after failure.

### Task 1: Enforce atomic allocation and migrate historical versions

**Ownership:** src/accuracy/store/plan-store.ts, src/accuracy/store/schema.ts, src/accuracy/store/db.ts only if needed for atomic migration, tests/kan-189-plan-versions.test.ts (and a migration test file if useful). Do not edit unrelated modules.
**Interfaces:** Keep saveAccuracyPlan, latestAccuracyPlan, listAccuracyPlans and getAccuracyPlanById contracts; use accuracyDb().transaction() as in provenance-store.ts.

- [ ] Add PostgreSQL-backed Vitest tests and run them against unchanged production code to establish failure: concurrent saves behind a real database barrier/lock with multiple connections; direct duplicate insert rejected; latest/list stable; rollback followed by next successful save uses the unconsumed version; workspace isolation and empty latest.
- [ ] Add migration tests using an isolated schema/table and the production migration statements: duplicate versions, timestamp ties, preservation of IDs/payload/metadata and unaffected workspaces, repeat migration, fresh schema uniqueness, atomic failure/retry and concurrent migration execution where feasible. Avoid sleeps as synchronization; bound lock waits and clean up fixtures.
- [ ] Implement save allocation and insert inside one shared-database transaction with workspace advisory lock. Read latest inside that transaction after acquiring lock. Propagate database errors so rollback occurs; return only a committed record. Add stable version/timestamp/ID ordering for reads.
- [ ] Extend schema metadata and runtime migration with matching workspace/version uniqueness. Repair duplicates deterministically in a transaction with a suitable table lock before installing uniqueness, preserving plan rows and semantic version order. Document the version-number policy and migration lock implications in comments/report. Do not scan/repair healthy history on every process startup unnecessarily.
- [ ] Run focused regressions: npx vitest run tests/kan-189-plan-versions.test.ts tests/accuracy-gantt-save-final.test.ts tests/accuracy-gantt-read.test.ts (include any migration test file), npx tsc --noEmit, focused eslint; record exact commands, exit codes, red/green evidence, files, migration risks and self-review in the report. Controller will handle final full checks and commit.

## Execution and recovery

Baseline f5824cd0 on fix/kan-189-plan-versions in /private/tmp/synapse-kan189. Main checkout contains unrelated user edits and must remain untouched. One integrated task because migration and write serialization establish the same database invariant. Task reviewer and fresh whole-branch reviewer are required. Publication authorization is provided by the invoked ticket workflow; leave PR open into main and wait for latest-head CI before Jira Done.
