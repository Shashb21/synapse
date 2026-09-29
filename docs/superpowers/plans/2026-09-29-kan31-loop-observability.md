# KAN-31 Loop Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain each actually produced accuracy-first agent-loop version, its critic findings and no-gold quality signals, and the judge's selected version so a production call run can be inspected.

**Architecture:** Add typed append-only agent events under each existing Postgres `accuracy_module_runs` row: snapshot, critique, and judgment. The shared `runShallowAgenticCycle` emits these events, while its three current callers supply call-specific source and invariant checks. A run detail read path reconstructs progression without changing the extraction response or downstream draft choice.

**Tech Stack:** TypeScript, Next.js 16.3.5 App Router, Drizzle ORM, Postgres, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-kan4-agent-loop-design.md`; Jira [KAN-31](https://synapse21.atlassian.net/browse/KAN-31).

## Global Constraints

- Work in the newer accuracy-first pipeline under `src/accuracy/`; the legacy S-numbered pipeline under `src/modules/` is outside KAN-31.
- Retain V0 and every revision actually produced; an early exit may leave only V0. Do not manufacture V1–V3 or increase production pass depth.
- Persist structured critic findings, judge selection and reason, source references, deterministic/model-based production signals, per-produced-version latency, tokens, and estimated cost.
- Production records must not claim gold precision, recall, F1, or measured recall. KAN-34 owns gold-standard experiments.
- Postgres is the canonical store. Existing final module output and downstream behavior must remain compatible.
- `coverage_decide`/`coverage_critic` are separate call kinds, and `partial_split`/`prioritize` are stubs; KAN-31 instruments only current callers of `runShallowAgenticCycle` (`need_extract`, `inventory_extract`, `ideate`).
- Full snapshot bodies may contain customer source material. Require a session for the new detail API and page (including demo sessions), scope reads to the requested workspace, and do not put snapshot bodies in general list responses or log output. The existing broad runs-list access is outside this slice.
- Follow `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` before changing route handlers.

## Review Focus

| Condition | Expected behavior and owning test |
| --- | --- |
| Critic accepts V0 before revision | Persist V0 and its critique, with judgment selecting V0; `tests/accuracy-agentic-cycle.test.ts`. |
| Revision or critic throws | Already produced snapshots remain queryable and the run records an error; `tests/accuracy-agent-events.test.ts`. |
| Source span points outside this run's source file or to a missing quote | Snapshot signal flags the invalid provenance with its source/block reference; `tests/accuracy-need-extract.test.ts`. |
| Run ID belongs to another workspace or viewer has no session | Detail lookup reveals no events or returns 401 before reading; `tests/accuracy-agent-events.test.ts`. |
| No gold pack in production | Every snapshot has `evaluation_context: "production"` and no gold metric names; `tests/accuracy-agentic-cycle.test.ts`. |

---

## File structure and ownership

- `src/accuracy/store/schema.ts`: additive Postgres event table and unique event identity.
- `src/accuracy/kernel/agent-events.ts`: typed event contracts, append/read operations, and reconstruction of one run's progression.
- `src/accuracy/kernel/contracts.ts`, `observability.ts`, `run.ts`: recorder connection and run-scoped measurement access; keep existing module-run storage intact.
- `src/accuracy/kernel/agentic.ts`: shared loop event timing and judgment, with default depth and early exit preserved.
- `src/accuracy/modules/{need-extract,inventory-extract,ideate}/module.ts`: structured issues and call-specific production checks.
- `src/app/api/accuracy/runs/[run_id]/route.ts`, `src/app/accuracy/runs/[run_id]/page.tsx`, and `src/app/accuracy/runs/page.tsx`: workspace-scoped detail read and progression link/display, without expanding list payloads.
- `tests/accuracy-agent-events.test.ts`, `tests/accuracy-agentic-cycle.test.ts`, and existing three module test files: behavior and persistence proof.

### Task 1: Append-only event records and scoped reads

**Files:**
- Modify: `src/accuracy/store/schema.ts`, `src/accuracy/store/tenant.ts`
- Create: `src/accuracy/kernel/agent-events.ts`
- Test: `tests/accuracy-agent-events.test.ts`

**Interfaces:**
- Produces: `AgentSnapshotEvent` (`event_type: "snapshot"`, `iteration: number`, `output: unknown`, `evaluation_context: "production"`, `signals: ProductionSignals`, `latency_ms: number`, `token_usage: TokenUsage`, `cost_usd: number`), `AgentCritiqueEvent` (`event_type: "critique"`, `iteration`, `score`, `issues: CriticIssue[]`, `latency_ms`, `token_usage`, `cost_usd`), and `AgentJudgmentEvent` (`event_type: "judgment"`, `selected_iteration`, `reason`, `latency_ms`, `token_usage`, `cost_usd`).
- Produces: `appendAgentEvent(args: { run_id: string; workspace_id: string; event: AgentEvent }): Promise<void>` and `readAgentProgression(args: { run_id: string; workspace_id: string }): Promise<AgentProgression | null>`.
- `CriticIssue` contains a stable `issue_id`, category/code, severity, claim, optional `{source_file_id, block_id}`, and suggested action. `ProductionSignals` contains quote-validity counts, invariant failures, and an explicit `not_checked` completeness state until KAN-32; the paired critique provides the issue count. Neither event type permits gold metrics.
- Store each event in `accuracy_agent_events` with `id`, `run_id`, `workspace_id`, `event_type`, nullable `iteration`, `payload` JSONB, `recorded_at`; enforce uniqueness for one event of a type per run/iteration. The judgment uses a single `iteration = -1` key. Add an index for `run_id` and `workspace_id`.

- [ ] **Step 1: Write failing persistence tests.** Insert a module-run fixture; append V0, critique, V1, and judgment; read them in order and assert exact bodies, distinct event IDs, version numbers, source refs, and production-only signals. Assert duplicate append fails, cross-workspace read returns null, and an error-status run still exposes its earlier V0. Assert workspace deletion removes its events.
- [ ] **Step 2: Run `npm test -- tests/accuracy-agent-events.test.ts`.** Expect failure because the table/functions do not exist.
- [ ] **Step 3: Add the table, typed events, append/read functions, and workspace cleanup.** Validate event payloads before insert with Zod; verify the parent run belongs to the requested workspace; insert without overwriting existing events. Read only after matching the parent run and sort by iteration and event type. Do not truncate snapshot JSON as `RunStep` does.
- [ ] **Step 4: Run `npm test -- tests/accuracy-agent-events.test.ts`.** Expect all Task 1 assertions to pass.
- [ ] **Step 5: Commit `feat(kan-31): persist agent loop events`.**

### Task 2: Capture real versions, findings, and production signals

**Files:**
- Modify: `src/accuracy/kernel/agentic.ts`, `src/accuracy/kernel/contracts.ts`, `src/accuracy/kernel/observability.ts`, `src/accuracy/kernel/run.ts`
- Modify: `src/accuracy/modules/need-extract/module.ts`, `src/accuracy/modules/inventory-extract/module.ts`, `src/accuracy/modules/ideate/module.ts`
- Test: `tests/accuracy-agentic-cycle.test.ts`, `tests/accuracy-need-extract.test.ts`, `tests/accuracy-inventory-extract.test.ts`, `tests/accuracy-ideate.test.ts`, `tests/accuracy-coverage-decide.test.ts`, `tests/accuracy-run-api-key.test.ts`

**Interfaces:**
- Consumes Task 1's `AgentEvent`, `CriticIssue`, and `appendAgentEvent`.
- Extend `RunHandle` with `recordAgentEvent(event: AgentEvent): Promise<void>` and `usageSummary(): { token_usage: TokenUsage; cost_usd: number }`; update test handles. The recorder owns `run_id` and workspace identity and supplies persistence; module callers never choose either identity.
- Change `runShallowAgenticCycle<T>` to require `run: RunHandle` and a critic callback returning `{ score: number; issues: CriticIssue[] }`; proposer still receives human-readable issue claims. Add `onSnapshot(draft, iteration): Promise<ProductionSignals>` for call-specific checks. Keep `maxExchanges` default 1 and the current early-exit rule.
- The selected iteration is the latest produced version under today's judge policy. Record the reason as the current latest-version policy; preserve existing final output exactly. KAN-37 may introduce mixed selections later.

- [ ] **Step 1: Write failing loop tests.** Verify V0/critique/judgment on early exit; V0/critique/V1/critique/judgment on a revision; snapshot output remains exact; token/cost and latency are per-produced-version; failure after V0 leaves it recorded. Assert each event says production and contains no precision/recall/F1.
- [ ] **Step 2: Run `npm test -- tests/accuracy-agentic-cycle.test.ts`.** Expect failures for the absent capture contract.
- [ ] **Step 3: Implement shared capture and adapt the three callers.** Persist a snapshot immediately after each proposer/reviser returns, then persist its critique; persist a judgment after judge returns. Calculate token/cost as recorder deltas around each proposer, critic, and judge call, and latency for each call, so full-loop cost can be reconstructed. Convert existing call-specific critic checks into structured issues; attach source file/block references where present. Need/inventory checks validate existing quote spans against parse blocks and report unchecked when the referenced block is unavailable; ideate checks its existing eligibility/duplicate invariants and marks quote grounding not applicable. Preserve prompts, pass depth, and final outputs.
- [ ] **Step 4: Add module tests.** Assert an invalid need/tactic source quote is flagged, structured findings retain available source references, `ideate` has applicable invariant signals, and existing stub/final output behavior is unchanged.
- [ ] **Step 5: Run `npm test -- tests/accuracy-agentic-cycle.test.ts tests/accuracy-need-extract.test.ts tests/accuracy-inventory-extract.test.ts tests/accuracy-ideate.test.ts` and `npm run typecheck`.** Expect pass.
- [ ] **Step 6: Commit `feat(kan-31): capture production loop versions`.**

### Task 3: Inspect one run's progression

**Files:**
- Create: `src/app/api/accuracy/runs/[run_id]/route.ts`, `src/app/accuracy/runs/[run_id]/page.tsx`
- Modify: `src/app/accuracy/runs/page.tsx`, `src/accuracy/index.ts`
- Test: `tests/accuracy-agent-events.test.ts`, `tests/accuracy-hygiene.test.ts`

**Interfaces:**
- Consumes Task 1's `readAgentProgression`.
- GET `/api/accuracy/runs/{run_id}?workspace_id={workspace_id}` requires `sessionContext().signed_in`, returns the matching run's progression with V0 and each actual revision, linked critic issues/signals/cost/latency, and judgment; returns 401 without a session and 404 for unknown or wrong-workspace run.
- The Runs page keeps its current list compact and links agentic runs to a separate version progression page. Display production signals as checks/risk flags, never as gold accuracy.

- [ ] **Step 1: Write failing route and rendering tests.** For a signed-in run with V0 and V1, assert the detail route returns both exact versions in order with critique and selected version; assert an unsigned request yields 401 and a wrong workspace yields 404. Assert the UI renders version labels and a selected-version reason while the general runs list does not inline snapshot JSON.
- [ ] **Step 2: Run `npm test -- tests/accuracy-agent-events.test.ts tests/accuracy-hygiene.test.ts`.** Expect the new assertions to fail.
- [ ] **Step 3: Implement the detail route and Runs progression display.** Reuse the workspace-scoped read; validate `workspace_id` and `run_id` before lookup; expose only one requested run's bodies. Keep readable error/empty states. Use the documented Next route-handler convention.
- [ ] **Step 4: Run `npm test -- tests/accuracy-agent-events.test.ts tests/accuracy-hygiene.test.ts`, `npm run typecheck`, and `npm run lint`.** Expect pass.
- [ ] **Step 5: Commit `feat(kan-31): inspect agent loop progression`.**

## KAN-31 completion check

Run `npm test -- tests/accuracy-agent-events.test.ts tests/accuracy-agentic-cycle.test.ts tests/accuracy-need-extract.test.ts tests/accuracy-inventory-extract.test.ts tests/accuracy-ideate.test.ts tests/accuracy-hygiene.test.ts` and `npm run typecheck`. Verify KAN-31's four acceptance criteria against the recorded events and Runs view. Leave production pass count, downstream final output, benchmark scoring, and mixed selection to their later Jira tickets.
