# Module boundaries

Synapse is built as a set of modules behind versioned contracts. A stage is a
contract slot: exactly one implementation is active at a time, and replacing it
touches that module plus its contract tests — never a sibling stage.

Product intent and locked decisions live in the project context and architecture
plan the team keeps outside this repo. This file describes what the code does.

## The kernel

`src/modules/kernel/`

| File | Responsibility |
| --- | --- |
| `contracts.ts` | Stage ids S0–S10, stage descriptors, `SynapseModule`, module manifest, run/step/eval/signal types, contract version. |
| `registry.ts` | In-memory registration, per-stage activation (the upgrade seam), stage wiring for the UI. |
| `run.ts` | The only way a stage is invoked: role check → open run → validate input → resolve route → execute → validate output → file evals and signals. |
| `routing.ts` | Per-stage provider/model/params/fallbacks, route resolution with degradation, the one-click default switch, and the JSON completion handed to a module. |
| `observability.ts` | Run records: input, output, steps with payloads, route, timings, errors, eval scores. Stage health. |
| `edit-records.ts` | Every user edit with its mandatory rationale. |
| `hillclimb.ts` | Signals derived from edits, evals and parse quality, plus the digest each agentic stage reads before it proposes. |
| `hillclimb-loop.ts` | Prompt-variant sweep: score variants against curated gold, update baselines, file promotion signals. |
| `baselines.ts` | Per-stage, per-prompt-version metric baselines (`prompt_baselines`). |
| `prompt-versions.ts` / `prompt-variant.ts` | Registered variants and `AsyncLocalStorage` scope for hillclimb evals. |
| `evals.ts` | Per-stage eval runs and the harness runner. |
| `agentic.ts` | The shared loop: propose → critique → revise, three exchanges, then judge. Model calls only; the local proposers run solely under the test stub. |
| `llm.ts` / `no-llm.ts` / `stage-errors.ts` | `requireLlm`, `completeAll` (re-ask, never fill in), the test-stub guard, and the customer- vs owner-facing wording when a model is missing or fails. |
| `ai-switch.ts` / `ai-sections.ts` / `stage-ai.ts` | The admin's AI master switch and per-section switches, and which stages the kernel refuses while AI is off. |
| `db.ts` / `schema.ts` | Platform tables. Module-owned DDL is applied by the kernel on first run. |

A module declares its own tables. `source_files`, `parsed_documents`,
`gap_candidates`, `tactic_candidates` and `mapping_candidates` are owned by their
stage directories; the plan-side tables (`priority_axes`, `priority_placements`,
`ideation_proposals`, `timeline_activities`, `iegp_plans`) are platform tables
because several surfaces read them.

## The agentic loop

Locked: every agentic stage runs **three proposer↔critic exchanges before the judge**. One exchange is
one critic response plus the revision the proposer makes in answer to it, so the judge only ever sees
the third revision.

```
propose → critique → revise   (exchange 1)
        → critique → revise   (exchange 2)
        → critique → revise   (exchange 3)
                    → judge
```

`runAgenticCycle` owns the loop. A stage supplies three things: a proposer that handles both the first
proposal and later revisions (it receives the round number, the previous candidates and the critiques),
a critic that scores candidates and tags machine-readable `issues`, and a judge. Candidate identity is
stable across revisions, so critiques, the judge and the trace all line up.

Revision is not cosmetic. Each stage repairs what its critic can name: S2 trims a bundled statement and
re-derives a generic domain, S3 fattens a thin evidence question from its source quote, S4 gives up a
gap's weakest edge when it is over budget, S6 renames a leftover that restates its parent, S8 fills
missing axis scores and re-derives the band, S9 specifies a missing comparator or outcome. Anything the
critic drops is conceded.

The trace records `round1:proposer`, then `roundN:critic` and `roundN:proposer-revise` for each
exchange, then `judge`, plus an `exchanges` summary that the run page renders as a table. Loop quality
is scored on every run: `exchanges`, `dialogue_retention`, `critic_score_gain`, `accept_rate` and
`judge_confidence`.

## Stages

| Stage | Module id (version) | Kind | Reads | Writes |
| --- | --- | --- | --- | --- |
| S0 Upload | `s0-upload.local-store` (1.0.0) | records files; AI section *ingestion* | user files, demo pack | `source_files` |
| S1 Parse | `s1-parse.llm` (2.0.0) | LLM decides blocks, kinds and headings for PDF, PPTX, DOCX, XLSX and text; LlamaParse is disabled | `source_files` | `parsed_documents`, domain `sources` + `source_blocks` |
| S2 Gap extraction | `s2-gap-extract.pcj` (1.0.0) | model proposer → critic ×3 → judge | `parsed_documents` | `gap_candidates`, domain `gaps` + `needs` + links |
| S3 Tactic extraction | `s3-tactic-extract.pcj` (3.0.0) | model proposer → critic ×3 → judge | `parsed_documents` | `tactic_candidates`, source references, overlap review suggestions, domain `tactics` |
| S4 Mapping | `s4-kg-mapping.scored-pcj` (3.1.0) | LLM mapping table: one row per gap with a coverage verdict, confidence and rationale per tactic; critic ×3 → judge | domain gaps + tactics | `mapping_candidates`, domain `coverages` |
| S5 Validation gate | `s5-validation.human-gate` (1.0.0) | human gate, no model | domain state | domain state, `edit_records`, `hillclimb_signals` |
| S6 Partial split | `s6-partial-split.pcj` (2.1.0) | model proposes the split, critic ×3 → judge; applies only what the user validates | partial gaps + coverages | child gaps, `gap_versions`, `edit_records` |
| S7 Consolidation | `s7-consolidation.derived` (1.0.0) | derived, no model | validated state | nothing |
| S8 Prioritization | `s8-prioritization.axes` (2.0.0) | model scores every axis, critic ×3; the band is the quadrant, the user validates it | open gaps, axis config | `priority_placements` |
| S9 Ideation | `s9-ideation.pcj` (2.0.0) | model designs tactics for gaps validated High, critic ×3 → judge, per-gap cap | High open gaps | `ideation_proposals`, domain `tactics` (status `proposed`) on accept |
| S10 Gantt timeline | `s10-timeline.gantt` (2.0.0) | AI optional: model infers dependencies and estimates missing dates; human dates always win | validated state, placements | `timeline_activities`, `iegp_plans` |

The S4 module id keeps its historical `scored-pcj` slug; the deterministic scorer it once used (`scoreGapTacticMapping` in `src/lib/iegp/mapping.ts`) now runs only under the test stub, and every row it produces says no model was called.

Ingest (`src/app/api/iegp/ingest-pipeline.ts`) is the stage chain S0 → S1 → S2 → S3 → S4 through `runStage`; it refuses before writing anything if a judgement stage has no connected model. S1 writes through `persistSourceAndBlocks` and S2/S3 through `commitExtractedRecords` (`src/lib/iegp/store.ts`), so the stages and the hand-entry paths write through the same domain code.

## Cross-cutting

- **LLM routing** — `src/modules/llm/`. Five providers: xAI Grok (default
  route), Anthropic Claude (one-click alternate), OpenAI, Google Gemini,
  OpenRouter. Each authenticates only with a server-side API key from the
  environment (`XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `OPENROUTER_API_KEY`; `api-keys.ts` is the single source).
  There is no provider login and no key path for an end user. The owner sees
  each key's status and sets per-stage routing on `/admin/control` (see
  `docs/deployment-live.md`). A stored route whose model the provider no longer
  lists runs on the provider's default. With no provider key an agentic stage
  fails with a clear `no_llm` error naming the env var; there is no offline rule
  fallback (the removed `deterministic-local` route id is stripped from stored
  routing). S1 parse is an LLM stage too: every file type is parsed by the model
  routed to it.
- **AI switch** — `src/modules/kernel/ai-switch.ts` and `ai-sections.ts`. The
  Synapse admin decides, for every customer, on `/admin/control`: a master
  switch turns all AI off, and each AI section (ingestion, gap extraction,
  tactic extraction, mapping, partial split, prioritization, ideation) has its
  own switch. Every section starts off. Customers have no AI switch. With a
  section off its entry points refuse and the UI shows only the hand-entry path.
- **Identity and roles** — `src/modules/auth/`. Customers sign in with SSO
  (Google, Microsoft Entra ID, GitHub) and need a seat (`customers.ts`,
  `/admin/customers`); staff use email and password accounts (`accounts.ts`,
  `npm run create-admin`, `/admin/users`). There is no self sign-up. Roles:
  Medical Affairs (primary), contributing function, platform operator, viewer.
  Routing and the owner console are owner only; saving the IEGP as final is
  Medical Affairs only.
- **Rationale on every edit** — `recordEdit` refuses an empty rationale, stores
  before/after, and files the same rationale as a hillclimb signal for the stage
  that owns the edit.

## Surfaces

| Route | Binds to |
| --- | --- |
| `/` (Plan context, Upload, Evidence Inventory, Prioritization Matrix, Tactic Ideation) | ingest chain S0–S4, S5/S6 gates, S9 on `?place=tactics` |
| `/setup` | Plan context wizard (feeds S8, S9 and S10) |
| `/mappings` | S4 mapping table: accept, reject or restore proposed mappings |
| `/?place=plan` | S8 prioritization matrix with configurable axes (`/matrix` redirects here) |
| `/ideation` | S9 proposal review and ideas added by hand |
| `/timeline` | S10 timeline, built by hand or from a run: the final IEGP, saved as final and exportable as an image |
| `/admin/pipeline` | owner only: run a stage S0–S10 or a chain, see module, route and last run |
| `/admin/runs`, `/admin/runs/[id]` | owner only: stage health, run traces, edit rationales, signals, eval runs |
| `/admin/control` | owner only: AI master and section switches, per-provider key status, per-stage routing |
| `/admin/harness` | owner only: run each AI use case on its own against the live model |
| `/admin/evals`, `/admin/catalog` | owner only: gold evals, registered modules and prompt variants |
| `/admin/accuracy` | owner only: the accuracy lab (reference packs, ledger, coverage, plan, timeline) |
| `/admin/modules` | owner only: module versions |

## Testing

The full picture (Vitest, Playwright, the LLM stub, CI and gold) is in
[`sdlc/13-testing.md`](sdlc/13-testing.md). In short:

| Command | What it runs |
| --- | --- |
| `npm test` | Vitest (`tests/*.test.ts`): kernel contracts, the three-exchange loop, per-stage logic with the LLM stub, KAN regression tests, against Postgres. |
| `npm run test:e2e` | Every Playwright spec. |
| `npm run test:e2e:features` | The specs under `e2e/features/`: one per stage S0–S10 plus feature and KAN specs. |
| `npm run test:evals` | Only the gold-case tests in `e2e/features/`. |
| `npm run test:e2e:feature -- "S8 prioritization"` | One feature, by name. |

Specs seed their own state through the module API (`e2e/support/synapse.ts`) and assert on the run
ledger rather than page text, so a click that lands before hydration cannot produce a false pass. Under the
test LLM stub (`SYNAPSE_TEST_STUB_LLM=1`, refused in a production build) the agentic stages use local
proposers so the specs run without a live model.

## Adding or upgrading a module

1. Create `src/modules/stages/<stage>-<slug>/module.ts` exporting a
   `SynapseModule` with a manifest (`contract: 1`), Zod input and output schemas,
   and any module-owned DDL in `migrations`.
2. Register it in `src/modules/index.ts`.
3. Add contract tests: fixture input in, schema-valid output out, no live
   neighbours required.
4. Activate it for the stage in the control panel (or with `activateModule`).
   Nothing else changes.
