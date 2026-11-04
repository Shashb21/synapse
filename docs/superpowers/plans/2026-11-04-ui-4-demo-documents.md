# UI-4 Demo Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Owners can add actual bundled demo documents as durable private experiment sources, select/review multiple files and recover safely from partial preparation failures.
**Architecture:** Use CLIENT_DEMO_PACK, not short test fixtures or recorded outputs. Reuse prepareSource and updateExperiment, preserving revision checks and immutable documents. Add server allowlisted demo IDs, private provenance metadata, a discover/add endpoint, and a focused selection UI beside existing document choices.
**Tech Stack:** Next.js 16, TypeScript, React, Zod, Drizzle/PostgreSQL, Vitest and Playwright.
**Spec:** https://synapse21.atlassian.net/browse/UI-4 (fetched 2026-11-04); all acceptance criteria below.

## Global Constraints

- Owner-only Development APIs; no client-selected filesystem paths; server resolves identifiers against CLIENT_DEMO_PACK.
- Preserve experiment isolation, authorization, fixed document identities, frozen execution history, concurrency protection and spending safeguards.
- Do not alter customer workspaces, shared model routing, pipeline algorithms or human-review semantics.
- Bundled inputs must retain exact original bytes, parsed content, hashes and demo provenance while remaining private sources and usable after reopening.
- Preserve one-workspace boundary. Support private-only experiments. Never import demo ledger/results.
- Disclose AI preparation charges and retain ingestion availability/provider policies. No paid model calls in tests.
- Partial failures retain successes, show per-file outcomes and retry remaining selections only. Repeated requests must not create accidental duplicates, including concurrency/stale/network retry cases.
- Safe actionable errors with no filesystem paths or secrets.
- Publish both origin and github; PR targets updated-dev-environment-ui per ticket owner instruction. Leave PR open; await all latest-head CI.

## Review Focus

- Forged/unknown identifiers, extra path fields and unauthorized users are rejected before preparation.
- Lost response retry, repeated clicks and concurrent requests do not create duplicate saved sources.
- Partial success followed by failure refreshes revision before retry and preserves all saved sources.
- Reopening retains original bytes, parsed blocks, provenance and normal generation usability.
- AI unavailable/provider missing errors give recovery without changing customer data or routing.

### Task 1: Durable demo selection API and owner UI

**Files:** Extend src/modules/development/schema.ts and documents/store ownership as needed; create focused src/modules/development/demo-documents.ts, src/app/api/admin/development/[id]/demo-documents/route.ts and src/components/development/development-demo-documents.tsx (or same-scope names if existing patterns dictate). Integrate src/components/development/development-setup.tsx. Add tests/ui-4-demo-documents.test.ts and e2e/features/development-demo-documents.spec.ts; update contract documentation if metadata/API changes.
**Interfaces:** Server GET lists allowlisted id/title/filename metadata, POST accepts strict revision and one demo identifier. Single-file requests permit sequential preparation/progress and safe per-file outcomes. Reuse prepareSource for paid preparation policies. Preserve existing origin private and add optional demo provenance metadata if needed. Duplicate detection uses stable demo identity/content in the same experiment before AI; atomic revision update prevents concurrent double insertion. UI accepts updated experiment on each success, reloads after ambiguous failures and keeps successful selections out of retries.

- [ ] Trace existing preparation, store, auth guard, demo download behavior, UI-3 document controls and scripted e2e generation helpers before editing; read installed Next route docs.
- [ ] Add failing Vitest API/integration tests: exact bundled set/bytes, persisted parsed hash/content/provenance, allowed private imports, duplicate/retry/concurrency handling, owner/unknown/path rejection and isolation. Arrange/Act/Assert: set state, perform request, assert observable saved outputs and forbidden side effects.
- [ ] Implement minimal typed server API and metadata using existing guard/preparation/persistence contracts. Happy path and errors must be tested for new public helpers.
- [ ] Add accessible labelled multi-file selection, readable names, review selection, AI-cost disclosure, loading/progress, individual outcomes and retry-only-remaining behavior using existing visual patterns. Disable conflicting actions during preparation; guard experiment switching and unmount.
- [ ] Add browser proof creating private experiment, selecting demo files, handling partial failure/retry without duplication, reopening and starting scripted generation (no paid calls); verify narrow viewport and rendered UI.
- [ ] Run targeted Vitest, relevant Playwright, npx tsc --noEmit and targeted eslint. Record command/exit/results in task report. Run full unit suite once sufficient environment is available; all repository CI must pass later. Do not hide baseline failures or weaken unrelated tests.
- [ ] Self-review and report changed files, evidence, risks and any incomplete acceptance criteria. Do not commit/push; controller owns git publication.
