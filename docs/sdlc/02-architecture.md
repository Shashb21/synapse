# Architecture

This describes the product as it runs today: the customer IEGP app, the owner console at `/admin`, and the modules behind them. Requirements are [01-requirements.md](./01-requirements.md) (v2.1). Module contracts in detail: [../modules.md](../modules.md). Flows: [09-flow-high-level.md](./09-flow-high-level.md), [10-flow-technical.md](./10-flow-technical.md).

The v1 architecture (flat insight records, a theme catalog, a keyword/ontology scorer and a local hill-climb ladder) is retired. Its code (`src/lib/pipeline.ts`, `src/lib/store.ts`, LlamaParse ingest) was removed in KAN-21.

## Runtime

- Next.js 16 App Router on the Node runtime (file text extraction uses zip/xml, mammoth and xlsx), deployed on Vercel.
- Postgres is the only store (`DATABASE_URL`). There is no file store.
- `src/proxy.ts` is the first gate: customer pages and APIs need a session cookie and a signed, unexpired workspace cookie; `/login` and `/api/auth` are public; `/admin`, `/api/admin`, `/api/accuracy` and `/api/control` gate themselves by owner role. Sessions, membership and roles are then verified server-side on every request (`src/modules/auth/api-guard.ts`).

## Code layout

| Area | Path | What it owns |
| --- | --- | --- |
| Customer pages | `src/app/*` (not `admin`) | Plan context → Upload → Evidence Inventory (Gaps) → Prioritization Matrix → Tactic Ideation → Gantt Timeline, plus Ideation, Mappings, Needs, Setup, Sources, Workspaces, Login, Account. Room, Breakouts and Presentation stay in the code but are switched off (`ROOM_ENABLED`, `BREAKOUTS_ENABLED` are `false`) and redirect to the plan |
| Owner console | `src/app/admin/*` | AI master and section switches, provider key status and routing, AI harness, customers and seats, staff users, accuracy lab, pipeline, runs, evals, catalog, module versions, specs |
| IEGP domain | `src/lib/iegp/` | Gaps, needs, tactics, coverages, residuals, audit (priority bands are S8 placements, KAN-17); engine status rules; blank and demo contents |
| Kernel | `src/modules/kernel/` | Stage contracts, registry, `runStage`, routing, observability, edit records, evals, the AI switches |
| Stages | `src/modules/stages/s0…s10/` | One module per stage, S0 upload to S10 timeline |
| Identity | `src/modules/auth/` | SSO providers, verified identity, sessions, staff password accounts, customers and seats, roles, owner gate |
| Workspaces | `src/modules/workspaces/` | Workspaces, members, per-workspace schema scope, blank/demo contents |
| LLM access | `src/modules/llm/` | Provider catalog (xAI, Anthropic, OpenAI, Gemini, OpenRouter), server-side API keys from the environment (`api-keys.ts`) |
| Parsing | `src/lib/ingest/` | Mechanical text extraction (`local-parse.ts`) and LLM block structuring (`llm-structure.ts`), manual blocks |
| Accuracy lab | `src/accuracy/` | The owner-only accuracy tool, separate tables and routes |

## Data

- **One schema per workspace.** Every workspace's IEGP rows and module tables live in their own Postgres schema; queries are scoped with a per-query `search_path` resolved from the signed workspace cookie or a `runInWorkspace` scope. Nothing reads across workspaces.
- **Shared tables** in the public schema: workspaces and members (with a `demo` flag; the old `ai_enabled` column remains but no longer counts since KAN-53), staff accounts, customers and seat assignments, and platform settings (the AI master switch and the per-section switches).
- **Blank or demo.** A new workspace is created blank. Choosing demo data at creation, or the owner's "Load demo data", replaces the workspace's contents with the Velmara example; "Reset to blank" empties it. Both act on one workspace only (`src/modules/workspaces/contents.ts`).

## Identity

- Customers sign in only with SSO (Google, Microsoft Entra ID, GitHub). The callback creates a session only for a verified email that holds a seat on an active customer (`src/modules/auth/customers.ts`). There is no self sign-up.
- Staff sign in with email and password. The first admin comes from `npm run create-admin`; others are managed at `/admin/users`. Passwords are scrypt hashes with lockout after five failures.
- The owner is `OWNER_EMAILS`, an enabled admin account, or the operator role; only they reach `/admin`.
- Roles govern what a person may do to the plan: Medical Affairs, contributing function, platform operator, viewer (`src/modules/auth/roles.ts`). Separately, a workspace member is its owner or a member; only the owner renames it, manages members, or loads demo / resets it. Every mutating API checks these server-side, and the actor on every edit is the signed-in person.

## AI

- **Whether AI runs** is decided by the Synapse admin for every customer (KAN-53), in `/admin/control`: the platform master switch and one switch per AI section (ingestion, gap extraction, tactic extraction, mapping, partial split, prioritization, ideation; `src/modules/kernel/ai-sections.ts`), all stored in `platform_settings`. A section runs only when the master switch and its own switch are on; every section starts off. Customers have no AI switch. With a section off its entry points throw `AiDisabledError` and the UI shows only the manual paths.
- **Which model** is per-stage routing (`src/modules/kernel/routing.ts`): xAI Grok by default, with Anthropic Claude as the one-click alternate and OpenAI, Google Gemini and OpenRouter also available, each reached with its server-side API key from the environment (there is no provider login). With no provider key a stage fails with `no_llm`; nothing falls back to rules.
- **Parsing** (S1) is an LLM stage like the others: text is extracted mechanically, then the routed model decides blocks, kinds and headings for every file type. There is no separate parser service.
- **Agentic stages** (S2, S3, S4, S6, S8, S9) run a proposer, three critic exchanges and a judge (`src/modules/kernel/agentic.ts`). Human edits are recorded with a rationale and are never overwritten by a later run.

## Timeline

S10 lays activities out per prioritized gap. The timeline can be built entirely by hand: activities are created, dated, dragged and sequenced with no stage run and no model. With AI on, an S10 rebuild has the model infer dependencies and estimate any start, duration or readout lag nobody supplied; it keeps every hand edit. The chart exports as a PNG image. Medical Affairs saves a version as final. There is no PowerPoint export.

## Process

Engineering process (Jira, QA definition of done, CI, both remotes): [05-process.md](./05-process.md).
