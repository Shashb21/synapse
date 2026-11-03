# Development evaluation tools (KAN-210)

Development owns the retained historical KAN-100 benchmark and committed reference-pack utilities. Current customer experiments continue through the existing Development execution, evaluation, comparison and cost controls. The historical stages are not adapters for today's customer stages, and historical scores do not validate today's pipeline.

The classification below is about retaining model-selection capability. **Existing equivalent** means Development already provides the current-pipeline workflow. **Confirmed retained gap** means the historical capability remains useful and is retained locally, with its remaining UI/integration gap stated explicitly. **Obsolete duplicate** means the old Accuracy admin workflow should not become a second experiment application; KAN-212 subsequently retires that domain implementation without deleting historical records or affecting unrelated customer planning features.

| Accuracy capability | Classification | Development home / rationale |
| --- | --- | --- |
| Workspace, private uploads and parsed source setup | Existing equivalent | Development experiment setup selects a customer workspace or private uploads and freezes source identities. Reuse `development-setup.tsx`, `documents.ts` and owner APIs rather than creating an Accuracy workspace for each model comparison. |
| Current customer generation and route/role experiments | Existing equivalent | Existing execution controls run `gap_extraction`, `tactic_extraction`, `matching_coverage`, `partial_splitting`, with frozen requested/actual routes, single-pass/standard modes and AI-off checks. Historical stage names are not interchangeable with these stages. |
| Saved-output scoring and evaluator/reference configuration | Existing equivalent | Existing Development evaluation controls and profiles associate evaluator-only references and immutable scores with saved output identities. References do not become generation input. |
| Model/configuration comparison and selection evidence | Existing equivalent | `development-comparison.tsx` compares saved experiments/executions and supports explicit configuration copying. No model is selected or deployed automatically. |
| Generation results, raw replies, failed attempts and diagnostic history | Existing equivalent | `development-results.tsx` and execution/evaluation histories retain candidates, issues, raw call evidence, provenance, progress and failures. This reuses the current pipeline's record model. |
| Provider-cost estimates, usage, allowance, unknown-charge acknowledgement and corrections | Existing equivalent | Existing execution spending controls and ledger keep budgets execution-local and distinguish known usage from owner reports. Experiment choices do not write shared live settings. |
| Owner access, source isolation, frozen routes and AI-off protection | Existing equivalent | Existing Development owner gates, selected source snapshots and section availability checks already enforce these boundaries; the new tools page calls the same owner page gate. |
| Accuracy-specific control/routing and observability screens as another model-selection console | Obsolete duplicate | Development already exposes experiment routes, saved outcomes and costs. Copying Accuracy runtime/store/settings into it would create a competing experiment model and risk live-route writes. KAN-212 retires the legacy runtime consumers. |
| Accuracy workshop scenes, facilitator actions/tags and readiness screens | Obsolete duplicate as a model-selection entry point | These operate on the legacy Accuracy workshop ledger, rather than frozen Development experiment outputs. Current experiment setup, scoring, comparison and diagnostics are the supported evaluation workflow. Workshop domain behavior is outside this ownership move and is not reimplemented in Development. |
| Accuracy planning, prioritization, ideation, status derivation, Gantt and final-plan screens | Obsolete duplicate as a model-selection entry point | These are downstream plan-building workflows, not missing benchmark/scoring tools. They must not be copied into a second experiment application. Development retains the four current customer stages; no workshop/plan record migration or new stage adapter is introduced. |
| Historical local full-matrix benchmark and human-gold review | Confirmed retained gap, closed for local ownership | `src/modules/development/evaluation/benchmark/`; `npm run benchmark:kan100 -- <prepare\|run\|review> ...` preserves historical `need_extract`/`inventory_extract`, arguments, private artifacts, budget rules and human review. It remains separate from the customer worker. |
| Historical saved-run review/report/CSV browser viewer | Confirmed retained gap | Local no-paid CLI review and retained JSON/Markdown/four CSV outputs are preserved. The tools page explains access; it does not read arbitrary private artifacts. A browser result adapter and stage mapping need a separately defined contract. Current Development result history is not claimed to display these historical runs. |
| Historical extraction prompts and completeness audit identity | Confirmed retained gap, closed for local ownership | `evaluation/historical/` contains exact copies of the pure original implementations. Compatibility tests freeze their identities; Development evaluator prompts are not silently substituted. |
| Committed reference-pack loading and source recall helpers | Confirmed retained gap, closed for local ownership | `evaluation/reference-gold.ts` and `pack-recall.ts` retain pack-per-pack behavior and evaluator-only gold. Gold-file lookup still requires repository-root working directory; ideated tactics remain excluded from source recall. |
| Existing Accuracy reference import names | Retired by KAN-212 | KAN-212 retires the compatibility exports; callers use the Development evaluation helpers directly. |
| Discoverability of retained historical tools | Confirmed retained gap, closed for discovery | Owner-only `/admin/development/evaluation-tools` is linked from Development and Evaluation. It explains current versus historical scope and local commands, without provider dispatch or private-file APIs. |

Run local benchmark commands from the repository root. CLI `prepare` freezes explicitly selected private inputs; `run` retains its existing preflight, credentials, frozen-route, cost and review requirements. CLI `review` requires completed saved extraction/audits/billing, explicit decisions, approvals and a trusted checkpoint; it cannot invoke provider transports or load credential values. No benchmark is attached to the Development worker or customer stores by this ownership move.

The committed reference loader retains its repository-root `process.cwd()` precondition. Moving its static manifest import required a relative-path correction; filesystem lookup and pack separation remain unchanged. Unknown pack IDs still fail explicitly. The benchmark CLI continues to use explicit private input files rather than implicitly reading committed packs. Gold remains evaluator-only.

## Compatibility evidence

`tests/fixtures/kan210-original/` was captured **before relocation**, against Accuracy at base commit `5753c86`. It contains synthetic-only inputs and a completed 24-run matrix: two packs × two historical stages × two configurations × three repetitions. The source text is invented (“Synthetic older patients” and “Synthetic renal impairment”); all HTTP and credential behavior during capture was mocked. Empty extracted findings deliberately exercise honest zero recall against nonempty gold and completed human review. No customer documents, real credentials or provider calls were used.

Capture reused `tests/kan100-cli.test.ts`'s synthetic fixture and saved-review behavior, with batch ID `kan210-original-synthetic` and the clock fixed to `2026-11-03T12:00:00.000Z`. A temporary capture test called the original CLI `run`, staged exact synthetic human decisions, separately approved the requested review digests, then called `review` to completion. The capture asserted no HTTP or credential reads during final review. It passed on Vitest 3.2.7 (one test, 53.394s); the capture-only test was then removed to prevent accidental fixture refresh. Saved `inputs/` include config, packs, runtime, decisions, approvals and trusted checkpoint. Saved `artifacts/` include manifest, completed/interim results, human review requests, Markdown report and all four CSVs. `identity.json` records original SHA-256 file digests, prompt hashes, configuration/pack digests and every scoring identity.

The original function-body audit identity already depended on the TypeScript runner's emitted representation:

| Original runner | Fixed audit process identity |
| --- | --- |
| Vitest 3.2.7 | `88b7ea54b96e0a6fb3790a02df6801fe6f39a15f19c28dc805d357b873a74c92` |
| Node with `--import tsx` | `9b7ba447dfa4f9e32de8842429e1b1eea20dd0a74243f795f447e701517ba655` |

Both were captured against the original implementation before moving any files. The relocation guard checks both fixed values; it does not normalize or rename hashed functions, or accept new expected hashes. The saved-run fixture belongs to the original Vitest representation; this work makes no cross-runner saved-artifact compatibility claim. A future runner/compiler upgrade that changes function strings requires investigation rather than refreshing this fixture.

`tests/kan100-kan210-compatibility.test.ts` checks immutable original artifact bytes, config/packs, historical prompts and all scoring identities. It copies saved evidence into private Git-ignored storage, runs direct batch resume and CLI review with throwing transport/credential callbacks, and checks byte-equivalent evidence. The only comparison adjustment is the absolute `artifactDirectory` root in result JSON, which is machine-specific; retained fixture bytes/digests are never rewritten. The test fixes the clock to the original capture time to isolate relocation from elapsed-time bookkeeping.

## Verify

```sh
npm run test:kan100
npm run typecheck:kan100
npx vitest run tests/kan-210-evaluation-tools.test.tsx tests/accuracy-reference-gold.test.ts tests/accuracy-pack-recall.test.ts tests/kan-205-results.test.tsx
npx tsc --noEmit
```

The focused Development integration suite also requires an isolated Postgres database. Use the ticket's test database rather than a live app database; verify owner isolation, saved history/evaluations/comparison and unchanged live settings. Browser verification must cover the owner tools links, readable narrow/wide layouts, keyboard focus and non-owner denial. This documentation does not assert those runtime checks have run; exact evidence belongs in the task report.
