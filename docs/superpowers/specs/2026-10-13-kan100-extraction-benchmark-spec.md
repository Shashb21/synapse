## Problem Statement

Synapse needs evidence about which extraction models fit evidence-need extraction and existing-tactic extraction before a human changes the deployed system. Structured JSON and vendor benchmarks do not establish that a model finds the relevant pharmaceutical evidence items, preserves their specific meaning, or supplies reliable source citations.

The current reference evaluation measures identifiers and cannot by itself establish semantic completeness. Some gold answers are narrative, tactic extraction does not return all identifiers expected by the scorer, and the normal extraction endpoint limits input to the first 80 parsed blocks. A comparison that ignores these limitations can give misleading results.

The user needs a low-cost, isolated evaluation with saved metrics and concrete examples that can be analysed further. The evaluation must not update deployment or select models automatically.

## Solution

Build an isolated MVP benchmark comparing the resolved existing Synapse extraction configuration with LlamaExtract / Extract version 2.5 on the two BeOne reference decks: BGB-58067 / PRMT5i and Tislelizumab.

Use one frozen, complete parsed representation per deck. Score evidence needs and existing tactics separately, run each fixed configuration three times per deck, and evaluate completeness audits separately after extraction. A human reviews the reference answers and owns final item-level judgments.

Save private JSON and CSV analysis artifacts plus a readable report. Show gold-standard recall, omissions, valid additions, specificity failures, duplicates, unsupported findings, citation validity, parsing losses, failures, costs, and elapsed time. Advisory conclusions may differ by stage; a human makes model-selection and deployment decisions.

The provisional whole-experiment spending ceiling is US$10. Establish external-processing authorization and a feasible cost estimate before paid execution. If the agreed evaluation cannot finish, preserve results and explicitly report what remains incomplete.

## User Stories

1. As a model evaluator, I want to run the experiment in an isolated environment, so that evaluation cannot modify deployed records.
2. As a deployment owner, I want model changes to remain human decisions, so that benchmark outcomes cannot switch the live provider.
3. As a model evaluator, I want the existing resolved extraction configuration as a baseline, so that I compare the candidate against actual configured behaviour.
4. As a model evaluator, I want to start with one low-cost Extract configuration, so that the MVP remains focused and affordable.
5. As a model evaluator, I want evidence-need and tactic results reported separately, so that I can choose different models for different stages.
6. As a model evaluator, I want each complete reference deck processed, so that truncation does not masquerade as model quality.
7. As a model evaluator, I want reference packs kept separate, so that distinct asset evidence is not merged or confused.
8. As a model evaluator, I want frozen parsed content reused across configurations, so that parsing variation does not confound extraction comparison.
9. As a reviewer, I want source-block identity and boundaries preserved, so that extracted findings remain traceable.
10. As a reviewer, I want reviewed, versioned reference answers, so that every configuration is scored against the same gold standard.
11. As a reviewer, I want item-level semantic matches, so that a correct identifier alone cannot conceal an incorrect statement.
12. As a reviewer, I want faithful paraphrases accepted, so that wording differences do not penalize correct extraction.
13. As a reviewer, I want distinct needs preserved, so that broad summaries do not erase populations or evidence questions.
14. As a reviewer, I want concrete specificity examples, so that I can distinguish special-population summaries from separate older-patient and renal-impairment needs.
15. As a reviewer, I want duplicates identified without extra recall credit, so that output volume does not inflate quality.
16. As a reviewer, I want valid additional findings retained for adjudication, so that the existing gold standard does not reject genuine source evidence.
17. As a reviewer, I want reference corrections documented and applied to all configurations, so that comparison remains fair.
18. As a reviewer, I want missing gold items listed alongside recall percentages, so that aggregate scores do not hide important omissions.
19. As a reviewer, I want unsupported findings distinguished from valid additions, so that apparent completeness does not reward invention.
20. As a reviewer, I want supporting quotes checked against original source blocks, so that plausible citations do not substitute for attributable evidence.
21. As an analyst, I want content recall and citation validity reported separately, so that I can see whether correct findings are usable and traceable.
22. As an analyst, I want parsing losses exposed, so that information absent from parsed input remains visible in overall gold-standard recall.
23. As a reviewer, I want human-approved final judgments, so that automated matching suggestions do not become unreviewed truth.
24. As an analyst, I want provisional scores labelled, so that incomplete review is not mistaken for finalized evidence.
25. As a model evaluator, I want three runs per fixed configuration per deck, so that I can assess variation and recurring misses.
26. As a model evaluator, I want prompts, settings, and versions frozen for scoring, so that differences can be attributed to known configurations.
27. As a model evaluator, I want later tuning labelled separately, so that unequal tuning effort does not distort the first comparison.
28. As an analyst, I want completeness-audit results separated from extraction, so that audit contributions are not attributed to the extractor.
29. As a reviewer, I want true omission flags, missed omissions, and incorrect audit flags recorded, so that I can evaluate the audit's usefulness.
30. As an analyst, I want raw outputs, run metadata, and item-level judgments saved, so that I can inspect and reanalyse the evidence.
31. As an analyst, I want CSV summaries and detailed JSON, so that I can work in pandas or a spreadsheet without a new dashboard.
32. As a data owner, I want source-derived artifacts excluded from public Git commits, so that evaluation does not publish confidential content.
33. As a data owner, I want vendor-specific processing authorization established before upload, so that a separate environment is not mistaken for external-processing permission.
34. As a budget owner, I want a whole-experiment estimate and US$10 ceiling, so that setup, audits, retries, and tuning cannot silently expand spending.
35. As an analyst, I want extraction, audit, and total elapsed time recorded, so that I can assess speed alongside quality and cost.
36. As a model evaluator, I want failures and actual responding models recorded, so that fallbacks cannot be credited to the requested model.
37. As a budget owner, I want at most one retry for temporary service failures, so that repeated attempts do not obscure reliability or consume the budget.
38. As a model evaluator, I want incomplete experiments explicitly reported, so that fewer runs or missing review cannot appear to satisfy the full design.
39. As a decision maker, I want advisory conclusions with concrete trade-offs for each stage, so that I retain control over adoption.
40. As a decision maker, I want results described as performance on the reference decks, so that tuned reference performance is not overstated as generalization to unseen documents.

## Implementation Decisions

- Build the simplest complete isolated benchmark around the existing Accuracy extraction modules, reference-pack loading, quote validation, and completeness auditing. Reuse existing domain contracts where they fit; do not create a competing domain model or production provider framework.
- The evaluation environment uses separate result storage and must not connect with credentials permitting writes to deployed application data. It does not use the deployed database.
- The primary interface accepts a reference pack, frozen parsed source content, reference version, explicit run configuration, and human judgments; it produces persisted analysis artifacts and a report. Prefer one benchmark-batch boundary over new public interfaces across stages.
- Evidence needs are atomic sourced statements. Evidence gaps are decision objects linked to needs. Tactics are evidence-generating or disseminating activities. This experiment evaluates source extraction, not strategic gap formation or gap–tactic coverage.
- Use the existing extraction configuration as the baseline after resolving actual runtime settings. Code defaults are insufficient because persisted settings and provider fallbacks can change the responding model.
- Preserve the complete input. The current endpoint's 80-block cap must not constrain the primary comparison. Any separately reported capped comparison must be labelled distinctly.
- Freeze one parsed representation for each deck and preserve original block identity and boundaries. Supply equivalent complete content through each extractor's supported input format.
- Check raw candidate quotes against original parsed blocks. Candidate page references alone do not satisfy the source-block and verbatim-quote requirement.
- Report gold items absent from frozen parsed content as parsing losses. Do not silently remove them from the overall gold-standard denominator.
- Start with Extract configuration version 2.5, a fixed schema, citations enabled, and the lowest-cost tier passing setup. Verify actual account/version support before scored calls; do not substitute a moving latest version silently.
- The extraction schema must preserve need statements and identifying tactic details, literal source support, source locations, known source identifiers when present, and run identity. Do not invent missing attributes or silently equate identifiers with semantic correctness.
- Include original-file parsing comparison only if the text-input pilot proves unsuitable; label parsing-plus-extraction results accordingly.
- Run three scored repetitions per fixed configuration per deck. Preserve original outputs, not just an averaged score.
- Review and freeze gold answers before scoring. A human owns final matches, additions, and disputed citations. Automated matching is advisory, and unreviewed metrics are provisional.
- Count an item once when its essential reference meaning is recovered. Faithful paraphrases count; broad summaries losing distinguishing details do not. Distinct tactics require distinguishing activity details. Duplicate outputs earn no extra recall credit.
- Additional supported findings are allowed. Review and document reference corrections, then rescore every configuration against the same revised reference version.
- Missing gold items do not automatically prohibit adoption. There is no fixed minimum recall or speed gate. Report exact percentages, counts, and concrete omissions for human judgment.
- Keep content recall, citation validity, and their intersection separate. Report additions, unsupported findings, duplicates, and parsing losses without hiding them in one combined score.
- Score extraction first, then run the same completeness-audit process for each configuration's output. Report genuine omissions flagged, omissions missed, and incorrect flags. An audit warning is not a recovered item.
- Use private local per-batch JSON, CSV, and a readable report following the existing Git-ignored runtime-data convention in the isolated workspace. Verify Git exclusion before saving source-derived artifacts.
- Persist source/reference identifiers and versions or hashes, source-code version, requested and actual provider/model/version/tier, schema and prompts/settings, run/attempt identity, raw outputs, citations, human judgments, metrics, timestamps, timings, costs, failures, and completion state. Never persist credentials.
- Keep tuning distinct from the first frozen comparison. Additional models or tiers must address a demonstrated weakness and remain separately labelled and within budget.
- Establish vendor-specific document-processing authorization before sending BeOne originals or derived text. Until then, use synthetic material for technical checks.
- Enforce a provisional US$10 whole-experiment ceiling including setup, extraction, audits, retries, and tuning. Estimate costs from current pricing and actual input size before paid execution. Text-token billing means slide counts alone are not a valid cost estimate.
- Record unavailable or pending usage/cost as unknown rather than zero. Do not start another paid call when a conservative estimate cannot establish that it fits the remaining budget.
- Record each failure and known charge. Permit at most one retry for temporary connection or service failures within budget. Do not retry completed low-recall outputs automatically.
- Failed model-specific calls remain failures. Separately label any fallback-model result instead of attributing it to the requested model.
- Record extraction, audit, and total elapsed time, including retries. Speed is a reported trade-off rather than a pass/fail criterion.
- Preserve completed artifacts and explicitly mark an experiment incomplete when authorization, citations, review, repetition count, or budget prevents the agreed deliverable. Do not silently reduce scope or increase spending.

## Testing Decisions

- Prefer one primary test seam: the isolated benchmark-batch interface, from supplied source/reference/configuration inputs and provider responses through to observable JSON/CSV/report artifacts. A test seam is the boundary where tests supply inputs and check outcomes.
- Test external behaviour: completeness of saved records, correct counts and judgments, source attribution, isolation, budget handling, retry limits, and completion status. Avoid tests tied to helper structure or internal call order.
- Use synthetic fixtures and controlled provider responses for routine automated tests; these must not upload BeOne material or incur API charges. Live scored runs are empirical evaluation evidence, distinct from software tests.
- Test a happy-path batch with separate packs and stages, three repetitions, human-reviewed matches, valid quotes, and consistent saved summaries.
- Test missing, extra, duplicate, paraphrased, and overly broad findings. Include a specific example where a special-populations summary cannot count as two distinct older-patient and renal-impairment needs.
- Test that wrong statements with correct identifiers do not count as recovered items, and correct semantic findings without identifiers remain reviewable.
- Test that valid quote text must belong to the cited source block; a valid-looking page number or a quote from another block is insufficient.
- Test that parsing omissions remain in overall gold recall and are labelled separately.
- Test that gold corrections apply consistently to all configurations and that unreviewed judgments cannot produce final human-approved scores.
- Test that audit flags do not inflate extraction recall and that audit outcomes are reported separately.
- Test full-input handling beyond 80 blocks, pack separation, no deployed writes, and private artifact exclusion.
- Test failed calls, one permitted temporary retry, no retry for low recall, fallback attribution, unknown usage, insufficient budget, and incomplete-run reporting.
- Reuse existing prior art: Accuracy reference-pack and recall tests, need/inventory extraction contract tests, quote-validator tests, completeness-audit tests, routing tests, and cost-rollup tests. Extend at existing boundaries rather than introducing independent scoring rules.
- Follow the repository's existing TypeScript/Vitest test tooling for TypeScript changes. If Python analysis code is introduced, use pytest for that code.
- Record the smallest sufficient verification command and result for implementation. Record live benchmark configuration, outcomes, and human-review state separately; passing an oracle-from-gold test is not evidence of live extraction accuracy.

## Out of Scope

- Automatic model selection, deployment, live provider switching, or writes to deployed data.
- Production integration; a human may commission a follow-up issue after reviewing results.
- Agentic consolidation loops, canonical tactic grouping, group-type taxonomy, merge/unmerge workflows, or evaluation of those features.
- Gap formation, gap–tactic matching, coverage decisions, prioritization, tactic ideation, or timeline changes.
- A broad comparison across all models, tiers, document formats, or additional datasets.
- A new dashboard, database, generic provider framework, RAG layer, or redesign of the existing application.
- Removing completeness checks, quote validation, provenance, or human decision gates.
- A mandatory 100% recall gate, a production speed requirement, or claims of performance on unseen documents.
- Unapproved document uploads, hidden model substitutions, unlimited retries, or spending beyond the agreed ceiling.

## Further Notes

The interview settled all design branches. The existing issue previously included broader consolidation and coverage experiments; this specification supersedes that scope with the user-agreed extraction MVP.

Execution prerequisites remain: isolated workspace, reviewed gold answers, resolved baseline settings, confirmed Extract configuration and citation behaviour, documented BeOne processing authorization, and a whole-experiment cost estimate within US$10. Interview agreement to require authorization is not itself upload authorization.

Current Accuracy parsing uses local text extraction followed by a routed LLM and disables LlamaParse; the reference README's contrary statement is stale. Benchmark the actual implementation. Existing identifier-based recall and oracle-from-gold checks are useful prior art but do not establish semantic extraction accuracy.

Completion requires stored run records, human-approved item judgments, per-deck/per-stage/per-run metrics, concrete failure examples, costs, timings, and advisory conclusions. An incomplete experiment must retain its evidence and explain unmet requirements rather than present itself as complete.

Official references:
- [Extract configuration](https://developers.llamaindex.ai/llamaparse/extract/guides/configuring-extract/)
- [Extract input formats](https://developers.llamaindex.ai/llamaparse/extract/sdk/)
- [Citations and response format](https://developers.llamaindex.ai/llamaparse/extract/guides/response-format/)
- [Pricing](https://developers.llamaindex.ai/llamaparse/general/pricing/)

