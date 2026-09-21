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
| `evals.ts` | Per-stage eval runs and the harness runner. |
| `agentic.ts` | The shared loop: propose → critique → revise, three exchanges, then judge. Both the LLM path and the local path. |
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

| Stage | Module id | Reads | Writes |
| --- | --- | --- | --- |
| S0 Upload | `s0-upload.local-store` | user files, demo pack | `source_files` |
| S1 Parse | `s1-parse.local` | `source_files` | `parsed_documents`, domain `sources` + `source_blocks` |
| S2 Gap extraction | `s2-gap-extract.pcj` | `parsed_documents` | `gap_candidates`, domain `gaps` + `needs` + links |
| S3 Tactic extraction | `s3-tactic-extract.pcj` | `parsed_documents` | `tactic_candidates`, domain `tactics` |
| S4 Knowledge graph | `s4-kg-mapping.scored-pcj` | domain gaps + tactics | `mapping_candidates`, domain `coverages` |
| S5 Validation gate | `s5-validation.human-gate` | domain state | domain state, `edit_records`, `hillclimb_signals` |
| S6 Partial split | `s6-partial-split.pcj` | partial gaps + coverages | child gaps, `gap_versions`, `edit_records` |
| S7 Consolidation | `s7-consolidation.derived` | validated state | nothing |
| S8 Prioritization | `s8-prioritization.axes` | open gaps, axis config | `priority_placements` |
| S9 Ideation | `s9-ideation.pcj` | High open gaps | `ideation_proposals`, domain `tactics` on accept |
| S10 Gantt timeline | `s10-timeline.gantt` | validated state, placements | `timeline_activities`, `iegp_plans` |

The original `ingestNeedFromText` still exists as the monolith path. It is now
composed of `persistSourceAndBlocks` (S1) and `commitExtractedRecords` (S2/S3),
with `applyEngineMappings` for S4, so the modular stages and the monolith write
through the same domain code.

## Cross-cutting

- **LLM routing** — `src/modules/llm/`. Five OAuth providers: xAI Grok (default
  route), Anthropic Claude (one-click alternate), OpenAI, Google Gemini,
  OpenRouter. There is no API-key path for an end user. `deterministic-local` is
  the offline route: agentic stages fall back to their local proposer, critic and
  judge, so the pipeline is end-to-end before anyone logs in.
- **Identity and roles** — `src/modules/auth/`. OAuth sign-in (Google, Microsoft
  Entra ID, GitHub) when configured; otherwise demo mode, where the typed-name
  gate the app already uses is the actor. Roles: Medical Affairs (primary),
  contributing function, platform operator, viewer. Control-panel routing is open
  to every role by product decision; saving the IEGP as final is not.
- **Rationale on every edit** — `recordEdit` refuses an empty rationale, stores
  before/after, and files the same rationale as a hillclimb signal for the stage
  that owns the edit.

## Surfaces

| Route | Binds to |
| --- | --- |
| `/` (Upload → Gaps → Prioritize → Tactics) | existing domain flow, S5/S6 gates |
| `/pipeline` | S0–S10: run a stage or a chain, see module, route and last run |
| `/runs`, `/runs/[id]` | observability: stage health, run traces, edit rationales, signals, eval runs |
| `/control` | control panel: session and role, per-provider OAuth login, per-stage routing, module versions |
| `/matrix` | S8 matrix with configurable axes |
| `/ideation` | S9 proposal review |
| `/timeline` | S10 Gantt: the final IEGP, saved as final and exportable |

## Testing

| Command | What it runs |
| --- | --- |
| `npm test` | Vitest: kernel contracts, the three-exchange loop, per-stage pure logic, and an S0→S10 pipeline suite against Postgres. |
| `npm run test:e2e` | Every Playwright spec. |
| `npm run test:e2e:features` | Feature-by-feature end-to-end specs under `e2e/features/`, one file per locked feature. |
| `npm run test:evals` | Only the gold-case harness tests, one per stage that ships one. |
| `npm run test:e2e:feature -- "S8 prioritization"` | One feature, by name. |

`e2e/features/` holds one spec per locked feature, so a feature fails on its own:

| Spec | Feature |
| --- | --- |
| `s0-upload.spec.ts` | Upload, checksum, dedupe, no extraction |
| `s1-parse.spec.ts` | Parse to blocks, quality signals, per-file failure |
| `s2-gap-extract.spec.ts` | Gap extraction, three exchanges, provenance on every gap |
| `s3-tactic-extract.spec.ts` | Tactic extraction, library dedupe via mid-dialogue withdrawal |
| `s4-kg-mapping.spec.ts` | Many-to-many edges, rationale per edge, per-gap budget |
| `s5-validation.spec.ts` | Classification, validation, rationale mandatory, override needs a reason |
| `s6-partial-split.spec.ts` | Split proposal, dialog fill, apply only what the user validates |
| `s7-consolidation.spec.ts` | Open/addressed lists, disjointness, consistency flags |
| `s8-prioritization.spec.ts` | Configurable axes, matrix cards, band validation, re-run safety |
| `s9-ideation.spec.ts` | High-only ideation, runnable designs, accept/reject with rationale |
| `s10-timeline.spec.ts` | Gantt render, activity detail, PNG export, save as final, dependency gating |
| `control-panel-oauth.spec.ts` | Five OAuth providers, Grok default, Claude one-click, no API-key field |
| `observability-trace.spec.ts` | Run traces, all three rounds on the page, failed runs kept |
| `hillclimb-rationale.spec.ts` | Edit rationale → signal → next proposer brief |

Specs seed their own state through the module API (`e2e/support/synapse.ts`) and assert on the run
ledger rather than page text, so a click that lands before hydration cannot produce a false pass. With
no OAuth client configured the specs assert that the trace says the route degraded to
`deterministic-local`, rather than skipping the feature.

## Adding or upgrading a module

1. Create `src/modules/stages/<stage>-<slug>/module.ts` exporting a
   `SynapseModule` with a manifest (`contract: 1`), Zod input and output schemas,
   and any module-owned DDL in `migrations`.
2. Register it in `src/modules/index.ts`.
3. Add contract tests: fixture input in, schema-valid output out, no live
   neighbours required.
4. Activate it for the stage in the control panel (or with `activateModule`).
   Nothing else changes.
