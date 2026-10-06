# KAN-41 explainable experiment results

## Authority and intent
Jira KAN-41 was re-fetched on 2026-10-06 with dependencies KAN-35 and KAN-40 confirmed Done. Starting commit is 88b0db3. Build a read-only comparison/history/export surface for retained experiments. Keep KAN-4 open, production behavior unchanged, and the personal-projects checkout untouched.

## Design
Reuse Postgres experiment records, pass-comparison evaluation, and mixed pipeline evidence. Add one derived report service and a workspace-scoped authenticated GET endpoint, then a workspace-linked Experiments page. No new persistence schema, runner, paid model execution, or automatic promotion. JSON exports one complete report; JSONL exports one complete comparison/standalone experiment per line, each with raw records and explanation. Every separately retained attempt stays visible, including running, failed, incomplete and mismatched attempts.

The report contains raw experiment inputs/outputs/evaluations and existing derived pass version deltas, item recovery/loss, correctness, regressions, actual routes/evaluators and runtime metering. Mixed records contain exact assemblies, selected/generated lineage, stages, gates, final outcomes, dimensional scoring applicability and costs/latency. UI renders these as readable tables and expandable evidence, with complete JSON/JSONL downloads. Raw data inspection supplements readable evidence; it does not replace it.

## Attribution policy
Match original document identities/fingerprints, gold ID/fingerprint and evaluator identity before any attributed statement. Existing stricter matching rules remain authoritative. Missing, malformed, stale gold or incomplete evidence yields descriptive results and explicit reasons; unavailable measurements display Unknown. Preserve historical evidence rather than rescoring it silently.

A completed eligible matched comparison with strictly greater exact source-gold recovery/correctness, no reduction of exact must-find recovery, and no increase in wrong/partial outcomes or serious regression may report Observed gain. Never infer correctness from human acceptance, nor infer whole-pipeline improvement from extraction scores. Mixed downstream dimensions without curated labels remain explicitly unscored/descriptive.

Consistent improvement requires at least two separately retained complete matched comparisons with disjoint experiment/call identities, the same original documents, gold, evaluator, configuration and candidate/baseline conditions, and a gain in every member of the entire comparable series. One comparison, duplicate IDs, condition drift, a neutral/loss result, failed repeat or unknown safety cannot establish consistency. Expose every member and the rule. The label is restricted to scored source-gold outcomes and is a descriptive repeated pattern, never statistical significance or production approval.

## Global Constraints
- Read-only reporting; preserve append-only Postgres evidence and production behavior.
- All reads and exports require sign-in and original source-workspace authorization; unavailable/foreign workspaces receive uniform 404.
- Match document, gold and evaluator versions before attribution; mismatches are Descriptive.
- One pair may be Observed gain, never Consistent improvement without separately retained matched repeats.
- Source-gold gain never establishes improvement in unscored downstream dimensions or deployment approval.
- Missing metering is Unknown, never known zero; raw evidence and selection lineage remain exportable.
- KAN-4 stays open; do not touch /Users/calixtan/personal-projects/synapse.
- Follow existing TypeScript/Vitest/Next.js architecture; add no dependencies.

## Verification
Behavioral Vitest coverage for attribution, mismatches, duplicates, adverse/failed repeats and immutable exports; real local Postgres history/scoping integration where practical; rendered UI tests for data, empty/error states and keyboard-accessible controls; typecheck and scoped lint. Arrange/Act/Assert means create representative retained evidence, derive/render the report, then assert observable outcomes. Existing 73 comparison tests passed at baseline with local Postgres access. Fixtures demonstrate application behavior, not real model quality.
