# KAN-32 Completeness Risk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inspect each produced extraction version for source-backed missing gaps or tactics, including a second distinct item in a block that already supports another item, and retain the fate of each finding.

**Architecture:** A semantic inspector compares complete, scoped parse blocks against the current item inventory. Deterministic validation checks its source quotes, importance classification, and issue lifecycle. The existing agent event stream stores each snapshot and its same-iteration completeness assessment; the shared loop may revise once at its current production default.

**Tech Stack:** TypeScript, Zod, Vitest, existing accuracy-first `JsonCompletion` and Postgres JSONB agent events.

**Spec:** `docs/superpowers/specs/2026-09-29-kan4-agent-loop-design.md`; Jira KAN-32.

## Global Constraints

- Apply only to the newer `src/accuracy/` call-kind pipeline, not the legacy `src/modules/` S0–S10 loop.
- Production keeps the current proposer/revision depth: `maxExchanges` defaults to one. A terminal V1 assessment may run, but it must not create V2.
- Production records completeness **risk** and source evidence, never gold precision, recall, F1, or reference-pack answers. `src/accuracy/eval/` remains separate.
- A citation for one item cannot cover every distinct item in the same block. An explicitly supported omission is important; an inferred or ambiguous possibility is advisory.
- Persist snapshots before their assessment, retain exact outputs and source-linked observations, and never silently treat a failed check as no omissions.
- Preserve existing extraction output, judge policy, standalone workspace completeness inbox, and downstream eligibility behavior. KAN-33 owns production pause behavior.
- Full snapshot and source content remains behind the existing authenticated, workspace-scoped run detail route.

## Review Focus

1. One block states A and B and A is cited: test that B is still reported with the same block reference (Task 1).
2. A model returns a non-verbatim quote or outside-scope block: test that it cannot become an important finding (Task 1).
3. A later model omits a prior finding's disposition: test that the prior issue remains unresolved (Task 1).
4. The final revision has no remaining revision budget: test that it still receives an assessment, without V2 (Task 2).
5. Production model assessment fails: test that the snapshot remains persisted and the run cannot claim `none_detected` (Tasks 1–2).

---

### Task 1: Source-grounded semantic inspector

**Files:**
- Create: `src/accuracy/modules/completeness-audit/snapshot-inspector.ts` — semantic comparison, evidence validation, lifecycle normalization; leave the workspace audit engine unchanged.
- Test: `tests/accuracy-snapshot-completeness.test.ts`.

**Interfaces:**
- Produce `SnapshotItem = { item_kind: "gap" | "tactic"; item_ref: string; statement: string; provenance: Array<{ source_file_id: string; block_id: string; quote: string }> }`.
- Produce `SuspectedOmission = { issue_id: string; item_kind: "gap" | "tactic"; summary: string; source_ref: { source_file_id: string; block_id: string }; evidence_quote: string; basis: "explicit" | "inferred"; importance: "important" | "advisory"; reason: string; suggested_action: string }`.
- Produce `OmissionResolution = { issue_id: string; outcome: "unresolved" | "partly_resolved" | "resolved" | "invalid"; reason: string; matched_item_ref?: string }`.
- Produce `SnapshotCompletenessAssessment = { risk_level: "not_applicable" | "none_detected" | "advisory" | "important" | "check_failed"; checked_block_ids: string[]; unchecked_block_ids: string[]; suspected_omissions: SuspectedOmission[]; prior_issue_resolutions: OmissionResolution[] }`.
- Export `inspectSnapshotCompleteness(args: { blocks: AuditBlockLite[]; items: SnapshotItem[]; prior_open_issues: SuspectedOmission[]; complete: JsonCompletion }): Promise<SnapshotCompletenessAssessment>`.
- Task 2 will persist this assessment on the paired critique; this task produces the domain type and inspector only.

- [ ] **Step 1: Write failing inspector tests.** Mock `JsonCompletion` and assert its prompt includes all supplied blocks and current items, even when A cites A+B's block; response for missing B yields a source-linked important omission. Assert explicit/advisory normalization, valid quote and block scope, distinct findings in one block, stable prior issue ID and explicit resolution, absent/malformed prior disposition remaining unresolved, and failed/malformed model response producing `check_failed` rather than `none_detected`.
- [ ] **Step 2: Run the focused test and confirm the new expectations fail.** `npm test -- --silent --maxWorkers=2 tests/accuracy-snapshot-completeness.test.ts`.
- [ ] **Step 3: Implement the contract and inspector.** Reuse `AUDITABLE_BLOCK_KINDS` and `completenessSkipReason` for deterministic scope selection, without the old cited-block coverage shortcut. Supply whole blocks to the model. Verify every returned source file, block, and verbatim quote against the selected scope; assign IDs in code, not from model wording. Map explicit to important and inferred to advisory. Carry every prior open issue forward unless an explicit valid disposition resolves, partly resolves, or invalidates it. Report uninspected scope in `unchecked_block_ids` and risk level. Keep output strict and free of gold fields. Handle provider/parse failures as `check_failed` with prior issues retained; never erase evidence.
- [ ] **Step 4: Run focused tests, typecheck, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-snapshot-completeness.test.ts`; `npm run typecheck`; commit `feat(kan-32): inspect source-linked omissions`.

### Task 2: Assess every produced agent snapshot

**Files:**
- Modify: `src/accuracy/kernel/agentic.ts` — pair each persisted snapshot with a measured completeness critique, preserve revision limit and failure ordering.
- Modify: `src/accuracy/kernel/agent-events.ts` — validated completeness assessment on critique events, with no gold metric fields.
- Test: `tests/accuracy-agentic-cycle.test.ts`, `tests/accuracy-agent-events.test.ts`.

**Interfaces:**
- Consume `SnapshotCompletenessAssessment` and `SuspectedOmission` from Task 1.
- Extend the loop arguments with optional `onCompleteness(draft: T, prior_open_issues: SuspectedOmission[]): Promise<SnapshotCompletenessAssessment>`; when absent (for example `ideate`), record `not_applicable` rather than implying that completeness was checked. The existing structural `critic` stays in place for V0 and any revision-eligible pass.
- The loop records one `critique` event for every snapshot, including terminal V1. That event contains the completeness assessment and combines existing structural issues with source-linked important omission issues for revision feedback. Existing V1 structural checks remain in snapshot signals without an extra structural critic invocation.
- Extend `AgentCritiqueEvent` with required `completeness: SnapshotCompletenessAssessment`. Keep `AgentSnapshotEvent.signals.completeness` as `"not_checked"` for the existing snapshot-time structural signal; the paired critique owns the assessed completeness result.

- [ ] **Step 1: Write failing loop and event-contract tests.** Assert V0 early exit has one snapshot/critique pair; default one-revision path has V0/critique/V1/critique/judgment, exactly two proposer calls, no V2, measured tokens/cost for both assessments, and V1's resolution references V0 issue ID. Assert an assessment failure leaves V0 exact output persisted and records or propagates `check_failed`, never clean completeness. Assert important omissions reach the reviser with item kind, source file/block, quote, and action; advisory ones do not force revision or block early exit. Assert strict event validation rejects injected gold fields.
- [ ] **Step 2: Run `npm test -- --silent --maxWorkers=2 tests/accuracy-agentic-cycle.test.ts tests/accuracy-agent-events.test.ts` and confirm failure.**
- [ ] **Step 3: Implement per-snapshot assessment and event validation.** Persist each snapshot first. Run the existing structural critic where it ran before, run completeness for every snapshot, then append the paired critique. Carry prior open omissions across versions. Keep default `maxExchanges = 1`, existing score/early-exit semantics except that important omissions require a revision when budget permits, and current latest-version judgment policy. Attribute completeness call usage and latency to its critique event. Preserve source-backed feedback in the reviser prompt without adding a second structural critic call after terminal V1.
- [ ] **Step 4: Run focused tests, typecheck, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-agentic-cycle.test.ts tests/accuracy-agent-events.test.ts`; `npm run typecheck`; commit `feat(kan-32): assess each produced version`.

### Task 3: Connect extraction calls and show completeness history

**Files:**
- Modify: `src/accuracy/modules/need-extract/module.ts`, `src/accuracy/modules/inventory-extract/module.ts` — scoped source loading and inspector adapters.
- Modify: `src/accuracy/store/claim-store.ts` — uncapped workspace/source query for active persisted gap and tactic inventory, avoiding the existing `listClaims` default limit.
- Modify: `src/app/accuracy/runs/[run_id]/page.tsx` — source-linked omission and resolution display.
- Test: `tests/accuracy-need-extract.test.ts`, `tests/accuracy-inventory-extract.test.ts`, `tests/accuracy-agent-events.test.ts`.

**Interfaces:**
- Consume `inspectSnapshotCompleteness`, `SnapshotItem`, and `onCompleteness` from Tasks 1–2.
- Current snapshot items include both the current draft's gap/tactic items and active workspace claims, with item type and provenance; use the exact requested source-block set for the proposer, quote checks, and inspector. Do not use the standalone audit's block-level resolved flags.

- [ ] **Step 1: Write failing integration and rendering tests.** Need and inventory runs each report a source-linked omission of the corresponding type, including B when A already cites its block; V1 records resolution after B is added. Verify target block IDs restrict both proposal and inspection scope, and missing source blocks cannot be reported as checked. Verify the detail page labels important/advisory, source file/block, evidence quote, and resolution outcome, while calling it production completeness risk rather than recall.
- [ ] **Step 2: Run the three focused test files and confirm failure.** `npm test -- --silent --maxWorkers=2 tests/accuracy-need-extract.test.ts tests/accuracy-inventory-extract.test.ts tests/accuracy-agent-events.test.ts`.
- [ ] **Step 3: Wire both adapters and presentation.** Load scoped blocks once per module run and reuse them for proposer, quote check, and completeness. Add an uncapped, workspace-scoped query for active persisted claims relevant to the source file, then provide those plus the current draft to the inspector. Keep user-visible extraction outputs and downstream behavior unchanged. Render the paired critique assessment for each version, including check failures and issue fate. Read relevant `node_modules/next/dist/docs/` guide before editing the Next page.
- [ ] **Step 4: Run focused tests, typecheck, targeted ESLint, full suite with two workers, and commit.** `npm test -- --silent --maxWorkers=2 tests/accuracy-need-extract.test.ts tests/accuracy-inventory-extract.test.ts tests/accuracy-agent-events.test.ts`; `npm run typecheck`; `npx eslint src/accuracy/modules/need-extract/module.ts src/accuracy/modules/inventory-extract/module.ts 'src/app/accuracy/runs/[run_id]/page.tsx'`; `npm test -- --silent --maxWorkers=2`; commit `feat(kan-32): surface completeness risk per version`.
