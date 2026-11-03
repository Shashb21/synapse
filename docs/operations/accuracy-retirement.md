# Accuracy retirement, retention and rollback

Inventory date: **2026-11-03**. Scope: KAN-213 documentation against retirement baseline `8708bbc9` (KAN-212). This is a repository and Git-history inventory, not an inspection of a live database, private filesystem, access policy or backup service.

## Current ownership and routes

Development owns experiments, model decisions, execution/evaluation history, comparisons and costs at `/admin/development`. Owner-only `/admin/development/evaluation-tools` explains retained historical benchmark/reference tools. AI & routing (`/admin/control`) owns deployed customer routing, provider-key status and AI switches. Experiment choices do not automatically deploy settings.

`/accuracy`, `/api/accuracy`, `/admin/accuracy` and their descendants return 404. Admin descendants enforce the existing owner gate before returning 404. Similarly named routes retain their normal behavior. The customer S0–S10 pipeline, customer planning and shared audit history remain separate.

KAN-212 removed the Accuracy runtime, UI/API consumers and Accuracy-only tests. **No automatic record migration occurred.** No table drop, data disposal, retention deadline or cleanup is authorized by this retirement. Existing records, sources, model evidence and audit history remain untouched. The [KAN-212 classification](../verification/kan-212-retirement.md) records capabilities and retired tests; the [KAN-210 inventory](../development/kan-210-inventory.md) explains retained evaluation boundaries.

## Retained database inventory

Source: `src/accuracy/store/schema.ts` at pre-retirement commit `6f4387a110bf77e9f3b601e71dca725ecf76e819`, inspected through Git on 2026-11-03. All 14 declared table names are retained below. This records schema intent/history; existence, row counts, private access and backup coverage in each deployed database are **unverified**.

| Table | Retained purpose |
| --- | --- |
| `accuracy_organizations` | Organization identities |
| `accuracy_workspaces` | Legacy workspace identities and context |
| `accuracy_source_files` | Source records and original content |
| `accuracy_parse_blocks` | Parsed source blocks |
| `accuracy_claims` | Claim ledger |
| `accuracy_provenance` | Claim/source provenance |
| `accuracy_completeness_verdicts` | Completeness audit evidence |
| `accuracy_miss_flag_actions` | Human miss-flag actions |
| `accuracy_coverage_joins` | Coverage relationships |
| `accuracy_module_runs` | Historical runs, inputs, outputs, traces and costs |
| `accuracy_routing_config` | Historical route configuration |
| `accuracy_call_modules` | Historical module activation/configuration |
| `accuracy_plans` | Saved plan versions |
| `accuracy_workshop_snapshots` | Workshop snapshots |

Shared audit and `llm_calls` records are also preserved; they are not additional Accuracy-specific tables. Retirement stops invoking Accuracy DDL and its mutable runtime rather than altering existing tables. Database operators retain ownership of access and recovery; removal of an application route does not restrict direct database access or erase historical payloads.

## Protected locations and backup coverage

Metadata sources: `.gitignore`, `reference/manifest.json` (paths/identities only), Development reference helpers and benchmark storage/input code at the retirement baseline; [benchmark runbook](../kan-100-benchmark-runbook.md) and [historical run-retention notes](accuracy-run-retention.md), inspected 2026-11-03. No private source or artifact content is reproduced here.

| Location | Protection / owner expectation | Coverage established by this task |
| --- | --- | --- |
| `reference/manifest.json`, `reference/<pack>/sources/`, `reference/<pack>/gold/` | Preserve pack separation, source identities and evaluator-only gold; restrict source access to authorized operators | Repository-declared/tracked locations only. Private copies, access grants and external backups unverified. Git history is not proof of a private backup policy. |
| `data/runtime/` | Git-ignored runtime state; retain existing files, with access limited to authorized operators | Ignore rule inspected; actual private holdings, permissions and backups unverified |
| `data/runtime/benchmark/<batchId>/` | Private manifests, raw responses, reports, JSON and four CSV outputs; benchmark checks exclusion, no symlinks and private files/directories | Code-declared storage; actual retained batches and independent backups unverified |
| Explicit operator inputs and `--runtime`, `--approvals`, `--checkpoint`, `--decisions` paths | Explicitly selected Git-excluded regular files, mode 600, in separate mode-700 operator directories outside editable batch artifacts; preserve trusted checkpoint and approvals together with evidence | Code/runbook contract only; actual locations, access and backup coverage unverified. `data/runtime/benchmark/operator-inputs/` is an example, not proof of private holdings. |
| Retained PostgreSQL tables, shared audit/call records, replicas, snapshots and archived write-ahead logs | Database operator controls least-privilege access and recovery; preserve original bytes and lineage | No live database/backup inspection or restore performed; all deployed coverage unverified |
| `tests/fixtures/kan210-original/` | Tracked synthetic compatibility evidence; preserve immutable bytes | Repository fixture exists; not a backup of real private runs or sources |

A backup must cover both database records and external source/artifact/operator files needed to interpret them. A database-only backup cannot recover a missing checkpoint or external benchmark file. Before operational rollback, the operator must record actual storage locations, backup identifiers/date, access owner and restore checks in a restricted operational record. Keep credentials and source-derived content out of public Jira, PRs and this repository. Do not change permissions, move holdings, expire backups or run the archived cleanup SQL as part of this ticket.

## Retained extraction and benchmark paths

Run from the repository root. Current retained helpers are `src/lib/ingest/local-parse.ts`, `src/modules/development/evaluation/reference-gold.ts`, `pack-recall.ts`, `historical/need-extract/prompts.ts`, `historical/inventory-extract/prompts.ts` and `historical/completeness-audit/engine.ts` and `historical/completeness-audit/prompts.ts` under the same evaluation directory. Helper identities are frozen by compatibility tests. Historical `need_extract`/`inventory_extract` stages do not map automatically to current customer stages.

`npm run benchmark:kan100 -- prepare`, `run` and `review` invoke `src/modules/development/evaluation/benchmark/scripts/kan100-benchmark.ts`. Use the full explicit arguments and private-storage, separate-approval, checkpoint, budget and credential-isolation rules in the [benchmark runbook](../kan-100-benchmark-runbook.md). `prepare` uses selected local source bytes. Saved-run `review` requires complete saved extraction/audits/billing and authenticated decisions/checkpoint and makes no provider calls. `run` may incur charges and needs separately authorized setup; this documentation does not authorize execution.

## Application rollback

**Rollback rehearsal: untested. No checkout, deployment, database restore or live provider call was performed for this documentation task.**

The consistent pre-retirement application is **`6f4387a110bf77e9f3b601e71dca725ecf76e819`**, the first parent of retirement implementation `aa8fcc5`; merge `8708bbc9` incorporates that retirement. Git history confirms this earlier application already includes KAN-210's Development relocation and KAN-211's live controls. Restore the whole application revision and its lockfile rather than copying old Accuracy files into the retired tree.

1. Record the deployed revision and environment configuration, stop competing writers for any operational change, and have the database/storage owner verify accessible backups of the untouched schema and external files listed above. Do not run seed, reset, cleanup or migration commands.
2. Prepare an isolated checkout or release artifact at the full pre-retirement commit. Install its locked dependencies with `npm ci` using the supported Node version. Retain compatible environment values/keys in the deployment secret store, never in the checkout. Build and validate against disposable copied data before selecting that artifact for deployment.
3. Confirm the checkout contains `src/accuracy/store/schema.ts`, `src/accuracy/modules/parse/ingest-file.ts`, `src/accuracy/modules/parse/upload-formats.ts`, `src/accuracy/modules/need-extract/module.ts`, `src/accuracy/modules/inventory-extract/module.ts`, `src/accuracy/kernel/extract-gate.ts`, their store dependencies and the associated UI/API routes. Whole-revision rollback restores these together. The shared local extraction helper remains `src/lib/ingest/local-parse.ts`.
4. Keep KAN-210's Development evaluation helpers and historical benchmark CLI from that same revision: reference-gold, pack-recall, historical prompts/audit, `benchmark/scripts/kan100-benchmark.ts`, package scripts and lockfile. From the repository root verify `npm run typecheck:kan100` and `npm run test:kan100`; run `npx next typegen` and `npx tsc --noEmit`, then isolated relevant application and owner-boundary tests before operational use. Benchmark `prepare`/`run`/`review` retain the commands/arguments above at this rollback revision; no retired Accuracy CLI import should be manually substituted.
5. With operator authorization for the deployment, select the complete verified application artifact. Validate owner authorization, restored routes, record visibility and unchanged sources/audits without invoking paid extraction. Record the deployed SHA and outcome. Roll forward by redeploying the complete retired revision if needed; keep all retained records and files.

Application rollback reconnects an older, consistent application to the retained schema. **Database restore is a separate recovery operation:** it can overwrite newer records and reintroduce old payloads. Do not restore a database merely to undo route retirement. Any necessary restore requires a database-owner plan and isolated recovery rehearsal, preserving newer data and matching external artifacts/checkpoints. Neither application rollback nor database restore has been rehearsed here.

## Verification evidence

See the [KAN-213 evidence matrix](../verification/kan-213-retirement.md) for current commands, results and limitations. Historical KAN-212 passing results do not certify the KAN-213 head. Publication, CI and resource cleanup belong to the parent task and must be recorded before release readiness is claimed.
