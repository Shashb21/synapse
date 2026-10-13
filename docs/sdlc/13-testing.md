# Testing

How the code is tested today. This replaces the retired v1 pages [04-tdd.md](./04-tdd.md), [06-eval-protocol.md](./06-eval-protocol.md), [11-regression.md](./11-regression.md) and [12-gold-set.md](./12-gold-set.md), which describe the removed insights engine. Requirements: [01-requirements.md](./01-requirements.md); compliance: [requirements-compliance.md](./requirements-compliance.md).

## Commands

| Command | What it runs |
| --- | --- |
| `npm test` | Vitest, every `tests/*.test.ts` (needs Postgres; `DATABASE_URL`) |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Every Playwright spec under `e2e/` |
| `npm run test:e2e:features` | Only `e2e/features/` |
| `npm run test:e2e:feature -- "<name>"` | One spec or test, by `--grep` |
| `npm run test:evals` | The "gold case" tests in `e2e/features/` |
| `npm run ci` | `vitest run && playwright test` |

## Unit and integration: Vitest

- **Where:** `tests/` (122 files), configured in `vitest.config.ts`: Node environment, files run one at a time (`fileParallelism: false`), 20 s timeouts. A few files opt into `jsdom` (for example `req-docs-mermaid.test.ts`, which parses every Mermaid block in the spec docs).
- **Database:** a real Postgres. `DATABASE_URL` defaults to `postgres://synapse:synapse@127.0.0.1:5432/synapse_test`; point it at a database of your own when several checkouts run at once.
- **AI on:** `tests/support/ai-on.ts` turns the platform master switch and every AI section on before each file (every section starts off on a fresh platform, KAN-53). Tests about AI off turn it off themselves.
- **Test-only environment** (set by the config, never in production):
  - `SYNAPSE_TEST_STUB_LLM=1` — the agentic stages use local proposers instead of a model (`isTestStub()` in `src/modules/kernel/llm.ts`). A production build that sees it throws. Stub output is labelled as such (for example, S4 rows say "Test stub: no model was called").
  - `SYNAPSE_TEST_ANON_API=1` — a route handler called directly with no session cookie acts as the demo Medical Affairs user named in the body (`src/modules/auth/api-guard.ts`).
- **What is covered:** kernel contracts and the S0→S10 pipeline (`modules-contracts`, `modules-pipeline`, `kernel-run-llm`); each LLM stage's parsing, retry and refusal rules (`llm-parse`, `s2-llm`, `s3-llm`, `s4-llm`, `s6-llm`, `prioritize-llm`, `s9-llm`, `s10-llm`); the IEGP engine and store (`iegp-*`); every manual path (`manual-*`, `place-by-hand`); AI off (`ai-off-*`, `ai-switch`, `kan-53-ai-sections`); auth, seats and the owner gate (`kan-10-*`, `kan-11-12-*`, `kan-22-*`, `kan-28-*`, `kan-59-*`, `owner-gate`); the accuracy lab (`accuracy-*`); and one file per Jira fix (`kan-<n>-*`).

## End to end: Playwright

- **Config:** `playwright.config.ts`. One worker, Chromium. It starts its **own** dev server with `SYNAPSE_TEST_STUB_LLM=1` and every provider key blanked, so no spec can reach a real model.
- **Isolation (KAN-19):** the suite never uses your dev server or dev database. The setup turns AI on platform-wide and specs reset workspaces, so it must not touch the data you work in.
  - Port: `E2E_PORT` (default **43219**; `npm run dev` is 43217).
  - Database: `E2E_DATABASE_URL` (default `postgres://synapse:synapse@127.0.0.1:5433/synapse_e2e`). Create it once: `docker exec synapse-postgres psql -U synapse -d synapse -c "create database synapse_e2e"`. In CI the workflow's `DATABASE_URL` (its Postgres service) is used.
  - The config refuses to run against the dev database (`synapse`) unless `E2E_ALLOW_DEV_DB=1`.
  - An existing server on the port is reused only with `E2E_REUSE=1`; otherwise Playwright starts its own and fails if the port is taken.
- **Setup:** `e2e/global.setup.ts` signs in once with the demo sign-in (development builds only), turns AI and every section on, and saves the cookies every other spec starts from.
- **Specs (45 files):**
  - `e2e/features/` — one spec per stage, `s0-upload` to `s10-timeline`, each with its own gold case; feature specs (`ai-off`, `ai-toggle-settings`, `control-panel-provider-keys`, `observability-trace`, `hillclimb-rationale`, `login-workspaces`, `admin-customers`, `admin-users`, `setup-wizard`, …); and KAN specs (`kan-8-tactic-ideation`, `kan-16-manual-and-gates`, `kan-25-manual-timeline`, `kan-26-blank-and-demo`, `kan-49` to `kan-55`, …). `room.spec.ts`, `prep-room.spec.ts` and `kan-55-breakouts.spec.ts` cover Room and Breakouts, which are switched off in the app.
  - `e2e/accuracy/` — the owner's accuracy lab: shell, happy path, LLM parse, ledger filters, Gantt save as final.
  - `e2e/admin/owner-console.spec.ts` — the owner console's sections and gate.
  - `e2e/user-flow.spec.ts`, `e2e/platform.spec.ts`, `e2e/briefing.spec.ts` — whole-app walks.
- **Harness:** `e2e/support/synapse.ts` seeds each spec's state through the module API and asserts on the run ledger rather than page text, so a click before hydration cannot pass by accident.

## CI

`.github/workflows/ci.yml` (workflow `regression`) runs on every push and pull request, with test-only `SESSION_SECRET`. Three jobs:

| Job | Steps |
| --- | --- |
| `check` — typecheck and lint | `npm ci`, `npx next typegen`, `npx tsc --noEmit`, `npx eslint . --max-warnings=-1` |
| `unit` — vitest | Postgres 16 service (`synapse_test`), `npx vitest run` |
| `e2e` — playwright | Postgres 16 service (`synapse_e2e`), Chromium install, `npx playwright test` (one retry on CI); the report is uploaded on failure |

## Gold

- **Stage evals (Velmara):** `src/modules/eval-gold/velmara-curated.ts`, pack `velmara-curated-v1`. Per demo source it lists the stages it feeds (S1, S2, S3) and what must be found. The stage modules' evals and the hillclimb prompt sweep (`src/modules/kernel/hillclimb-loop.ts`) score against it; results show at `/admin/evals` and on each run's trace.
- **Reference packs (accuracy lab):** `reference/<pack>/gold/gaps.json` and `tactics.json`, listed in `reference/manifest.json`, one gold per source pack and never mixed. `src/accuracy/eval/reference-gold.ts` loads them and `src/accuracy/eval/pack-recall.ts` scores recall of must-find gap ids, tactic numbers and tactic identifiers.
- Gold measures extraction against known cases; it does not prove that a new customer deck will extract cleanly. Human edits and their rationales feed the hillclimb signals for the next run.
