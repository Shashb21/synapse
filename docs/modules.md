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
| `agentic.ts` | The shared proposer → critic → judge loop, with the LLM path and the local path. |
| `db.ts` / `schema.ts` | Platform tables. Module-owned DDL is applied by the kernel on first run. |

A module declares its own tables. `source_files`, `parsed_documents`,
`gap_candidates`, `tactic_candidates` and `mapping_candidates` are owned by their
stage directories; the plan-side tables (`priority_axes`, `priority_placements`,
`ideation_proposals`, `timeline_activities`, `iegp_plans`) are platform tables
because several surfaces read them.

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

## Adding or upgrading a module

1. Create `src/modules/stages/<stage>-<slug>/module.ts` exporting a
   `SynapseModule` with a manifest (`contract: 1`), Zod input and output schemas,
   and any module-owned DDL in `migrations`.
2. Register it in `src/modules/index.ts`.
3. Add contract tests: fixture input in, schema-valid output out, no live
   neighbours required.
4. Activate it for the stage in the control panel (or with `activateModule`).
   Nothing else changes.
