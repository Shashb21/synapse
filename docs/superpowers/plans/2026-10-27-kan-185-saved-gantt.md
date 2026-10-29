# KAN-185 Saved Gantt Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Display and export Gantt bars, labels, version and hash from one frozen saved snapshot, with live edits explicitly unsaved.
**Architecture:** Reuse Accuracy plan snapshots and existing exports. Centralize server read selection in the gantt-project module; timeline and GET API consume it. Keep live projection available as a separately labelled view for editing. Switch data and metadata together; do not locally replace only the hash after saving.
**Tech Stack:** Next.js 16.3, React 19, TypeScript, Vitest, Playwright, PostgreSQL.
**Spec:** https://synapse21.atlassian.net/browse/KAN-185 (retrieved 2026-10-27).

## Global Constraints

- Save a final, edit live tactics, then reopen and export: content labelled with the saved hash matches that frozen snapshot.
- SVG/PNG exports and displayed version/hash refer to the same data.
- Live changes are visibly identified as unsaved.
- Earlier snapshots remain readable and unchanged.
- Reuse final-plan storage and existing export. Preserve owner authorization and error handling.
- Work only in /private/tmp/synapse-kan185. Do not change or revert the original checkout's uncommitted work.
- No schema change, new dependencies, or unrelated redesign. Use the repository's TypeScript Vitest/browser test conventions.

## Review Focus

- Legacy snapshots without labels/hash: use frozen activities and empty labels/ID fallback, never live labels, preserve existing computed hash compatibility.
- Save response before router refresh and delayed refresh: never attach a new hash/version to stale bars.
- Workspace navigation: no stale saved hash or activities leak across props/workspaces.
- Live edits including renamed or removed tactics and changed dates/dependencies/gaps: saved content stays frozen; edits explicitly unsaved.
- No saved plan or empty live projection: live editing/export works without saved metadata; saved chart remains available even if live is empty.

### Task 1: Bind saved charts and exports to frozen snapshots

**Files:**
- Modify: src/accuracy/modules/gantt-project/save-final.ts
- Modify: src/app/api/accuracy/gantt/route.ts
- Modify: src/app/admin/accuracy/timeline/page.tsx
- Modify: src/components/accuracy/accuracy-gantt-board.tsx
- Modify or add focused tests in tests/ and e2e/accuracy/accuracy-gantt-save-final.spec.ts

**Interfaces:**
- Consumes AccuracyPlanRecord.snapshot.activities/labels/counts/tactic_ids and snapshotHashForPlan/auditBundleFromPlan; projectWorkspaceGantt remains the live projector.
- Produces a shared server read model with saved data/metadata consistently paired and live projection separately available; preserve top-level API activities/catalog as saved when a plan exists and live otherwise. Preserve plan/hash/audit fields. Use additive live data field if needed.
- Board defaults to saved snapshot when available and offers clearly labelled saved/live selection. Live view has no saved hash/version/export filename. Live schedule editors must be labelled unsaved and cannot imply they mutate a saved snapshot.

- [ ] Step 1: Write regression tests first and show failure. Tests must prove GET and page share frozen read semantics; save-edit-read retains original activities/labels/hash and older plan records; no-plan and legacy-label/hash fallback; failures and auth retain existing behavior. Prefer direct behavior tests over source-string assertions.
- [ ] Step 2: Implement the shared read model in the responsible gantt-project module and wire API/page. Do not change snapshot persistence semantics. Document any new public helper. Derive saved fields from the same plan record and never live fallback for missing snapshot labels.
- [ ] Step 3: Update board to select saved versus live data coherently, including detail labels, export inputs and filenames. Keep current markup/style/accessibility. On save use the complete returned snapshot atomically or wait for server props while disabling misleading exports; never update only hash. Save button must still save current live projection. A saved snapshot must remain exportable with no current live bars.
- [ ] Step 4: Extend browser regression: save v1, edit live dates and label, reopen and assert original saved bar/detail/hash and SVG content; assert PNG comes from that same SVG using a browser canvas/image input observation or compare decoded export data; switch live and assert unsaved marker and no saved hash/version filename. Save v2 then ensure consistent metadata/data immediately and after reload; verify v1 unchanged via plan store/API in database test. Cover prop/workspace changes and missing labels/hash in focused unit/component tests.
- [ ] Step 5: Run smallest sufficient focused Vitest tests, focused browser regression with isolated test database, npm run typecheck and lint. Run full Vitest once before finishing if DB available. Record command, exit code, passed/failed count and environmental limitations. Never run tests against developer DB. Read relevant installed Next guides before changing route/page/router behavior.
- [ ] Step 6: Self-review diff and write report with RED/GREEN evidence, changes and concerns. Do not commit or push; controller handles git operations to comply with delegate-implement. Do not spawn subagents.
