# SDLC process

## Loop

1. **Requirements** ([01-requirements.md](./01-requirements.md)) carry stable `REQ-*` IDs. No silent scope: an owner decision that changes the product is written into the requirements.
2. **Jira.** Every task is an issue in project **KAN** (`synapse21.atlassian.net`). Branches, commits and PRs carry the issue key (`KAN-21-…`, `KAN-21: …`). Statuses: **To Do**, **In Progress**, **In Review** (implementation done and QA underway, or waiting on someone, with a comment saying what), **Done**.
3. **Tests first** for new behaviour: Vitest for logic, stores and route handlers (`tests/`), Playwright for user flows (`e2e/`). Test files for a Jira issue are named after it (`tests/kan-28-seats-sso.test.ts`, `e2e/features/kan-25-manual-timeline.spec.ts`).
4. **Implement** on the issue branch, in small commits.
5. **Checks** before merge: `npm test`, `npm run typecheck` (`next typegen` + `tsc`), `npm run lint` with no errors, and the e2e specs for the flows touched.
6. **QA is the definition of done.** An issue moves to Done only after QA of the running app from a real user's point of view, in a browser, with Playwright MCP and Claude in Chrome: the happy path, edge cases and invalid input, error states, regressions in related flows, and each role that matters. The QA comment on the issue lists each scenario, the tool, pass or fail, and evidence. A failed scenario keeps the issue In Progress. If a required QA tool is not connected, the issue stays In Review with a comment saying so.
7. **Compliance.** When a feature changes whether a requirement is met, update [requirements-compliance.md](./requirements-compliance.md) with the evidence. Nothing is marked Met without a check.

## CI

`.github/workflows/ci.yml` runs on every push and pull request, against Postgres 16: `npm ci`, `npm test`, `npx next typegen`, `npx tsc --noEmit`. Lint and the e2e suite are not in CI yet (REQ-OPS-002); run them locally.

Local e2e: `npm run test:e2e` starts a dev server on port 43217 with `SYNAPSE_TEST_STUB_LLM=1`, so agentic stages use local proposers and no live model is needed. `E2E_PORT` runs the suite against its own server, for example from a second worktree. The stub is never set in production.

## Origin and GitHub

Every published commit lands on both remotes:

- `origin` — Cursor Origin
- `github` — [github.com/Shashb21/synapse](https://github.com/Shashb21/synapse) (public; CI runs here)

Push both with `./scripts/push-both.sh` (or `git push origin` and `git push github` for the same branch). GitHub needs `GH_TOKEN` or `gh auth` with `repo` scope; never commit the token.

## Review checklist

- Every AI judgement goes through a routed LLM; no keyword, threshold or similarity rule decides anything (REQ-AI-001), and a missing model fails clearly (REQ-AI-002).
- Every AI output has a manual create and edit path, and a later run never overwrites a person's edit (REQ-MAN-001, REQ-MAN-002).
- With AI off (the master switch or that section's switch in `/admin/control`) the change still works by hand and calls no model (REQ-AI-004).
- Server-side role and workspace checks on every mutating API; the actor comes from the session, never the request body (REQ-AUTH-005, REQ-AUTH-006).
- Customer copy has no internal jargon: no stage codes, "hillclimb" or owner-console links (REQ-UX-008, REQ-ADM-002).
- Docs that the change makes stale (README, deploy checklist, `.env.example`, these specs) are updated in the same branch (REQ-OPS-005).

## Application flow

- [02-architecture.md](./02-architecture.md) — runtime, code layout, data, identity, AI
- [09-flow-high-level.md](./09-flow-high-level.md) — what a plan team does
- [10-flow-technical.md](./10-flow-technical.md) — stages, APIs and tables
