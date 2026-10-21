# KAN-100 extraction benchmark — interview decisions

Issue: https://synapse21.atlassian.net/browse/KAN-100

This document records decisions accepted during the grill-with-docs interview. The user requested conversion into a specification, now recorded in [the implementation spec](2026-10-13-kan100-extraction-benchmark-spec.md) and published to KAN-100. Product terminology and locked domain decisions remain owned by `docs/iegp-model.md`.

## Accepted decisions

- KAN-100 delivers a benchmark and evidence-backed adoption or rejection recommendation for LlamaExtract as an extraction candidate. Production integration belongs in a follow-up issue. A justified rejection is a successful experiment outcome.
- Include LlamaParse in the experiment only if the candidate requires it or existing parsing prevents a fair evaluation.
- Reducing missed evidence needs and existing tactics is the primary objective. Extracted items must be supported by their cited sources. Measure unsupported and duplicate items separately; a larger output count alone is not improvement.
- No fixed minimum recall or speed threshold determines adoption. Metrics and concrete failures inform a human decision.
- Run the evaluation in a separate environment, protecting the deployed system. The user's immediate objective is to understand which models fit evidence-need and existing-tactic extraction and how they perform.
- Compare extraction against a gold standard: reference answers representing the intended result, reviewed before execution using the matching rules below.
- Adoption-quality citations must trace to a specific source block and a verbatim supporting quote. Report content recall, citation validity, and their intersection separately, including citation failures.
- The baseline and candidates process each complete reference deck; packs are scored separately. Differences in input representation must be documented. A candidate requiring its own parser is a combined parsing-and-extraction comparison; results against the existing capped endpoint must be reported separately.
- Start with the existing extraction configuration versus LlamaExtract. Add another extraction model only to address a specific weakness revealed by that comparison. Score evidence-need and tactic extraction independently; coverage and prioritization model selection remain outside KAN-100.
- Evaluation writes inputs, outputs, and scores to separate result storage and must not update deployed data. A human owns any subsequent deployment change. Record source-code version and model settings per run.
- Review and freeze reference answers for comparison. Valid additional findings are allowed. Missing reference items must be exposed, but do not automatically block adoption: there is no 100% recall gate. Report the percentage of gold items found and the specific omissions. Document human-reviewed additions and score every candidate against the same reference version.
- Score distinct reference needs individually. Faithful paraphrases count; broad summaries that lose distinguishing details do not. Duplicates earn no additional credit. Include concrete scored examples, such as “more evidence needed in special populations” versus separate needs for older patients and patients with renal impairment. Apply equivalent specificity checks to tactics.
- Freeze the baseline's resolved model, prompts, and settings. Record the actual responding model. Failed model-specific calls remain failures; fallback-model results must be separately labelled.
- External processing of BeOne decks or derived text requires explicit authorization for the relevant vendor/account and processing terms. Agreement to this rule is not authorization to upload the documents. Use synthetic material for technical checks until authorization is established.
- Store metrics and supporting examples for further human analysis. Any stage-specific recommendation is advisory; a human makes the final model selection and deployment decision. Report recall counts/percentages, valid additions, unsupported findings, citation failures, cost, and elapsed time without hiding trade-offs in one combined score.
- Score extraction before completeness auditing. Run the same audit process against each candidate's output and report genuine omissions flagged, omissions not flagged, and incorrect flags. A flag alone does not count as a recovered extraction.
- Run each fixed configuration three times per deck. Report per-run metrics, variation, and recurring omissions. Separate prompt tuning from final scored runs.
- Minimize paid evaluation cost for the MVP under a provisional US$10 total ceiling, including setup, extraction, audits, retries, and tuning. Establish document authorization and estimate current-provider costs before paid execution. Stop before exceeding the cap; if the agreed design does not fit, present the estimate before changing scope or budget.
- Store each benchmark batch as private local JSON/CSV plus a readable report: run configuration/identifiers, per-run/per-stage metrics, item-level reference-to-output judgments, additions/omissions/duplicates/citation failures, and raw outputs. Source-derived content must stay outside public Git commits.
- Use a small setup check, then freeze existing baseline prompts and candidate configuration for the scored runs. Report any later tuning separately, recording changes; performance on decks used for tuning is not evidence of performance on unseen documents.
- Record each failed attempt, error, elapsed time, and known charge. Permit at most one retry for a temporary service or connection failure within the budget. Do not retry a completed extraction merely for low recall or attribute another model's fallback result to the requested model.
- A human owns final item-level matching, additional-finding adjudication, and disputed citation judgments. Automated matching may propose judgments; unreviewed metrics are provisional. Store decisions and short reasons for disputed cases; no paid LLM judge is planned for the MVP.
- Measure extraction, audit, and total elapsed time separately, including retries and variation across runs. Speed is a reported trade-off, not a pass/fail gate in this evaluation.
- Store batches under `data/runtime/kan100-benchmarks/<batch-id>/` in the isolated evaluation workspace, using the existing Git-ignored `data/runtime/` convention. Verify Git exclusion before storing source-derived results. Include reviewed reference version and run configuration; do not use the deployed database.
- Freeze one complete parsed representation per deck and preserve source-block identifiers/boundaries. Give baseline and candidate the same content in supported input formats. Check candidate quotations against original blocks. Report gold items absent from parsed content as parsing losses without hiding them from overall gold-standard recall. Do not add original-file parsing comparison unless the text-input pilot is unsuitable.
- Use Extract configuration version `2.5`, a fixed extraction schema, citations enabled, and the lowest-cost tier that passes setup. Verify account/version/citation support before freezing. Label subsequent tier/configuration changes separately.
- Missing authorization, unsuitable citations, or insufficient budget produces explicit incomplete results, not a silently reduced benchmark. Save completed results and state what remains untested. Fewer than three scored runs do not fulfil the agreed repeatability check.

## Completion evidence

The complete evaluation deliverable includes stored run records, reviewed reference version, human-approved item-level judgments, per-deck/per-stage/per-run metrics, concrete failure examples, costs, timings, and advisory conclusions for each extraction stage. Include additions, omissions, duplicates, unsupported findings, citation failures, parsing losses, failed calls, retries, and variation across runs. A human makes model-selection and deployment decisions; deployment is outside this issue.

Before execution, establish the isolated workspace, BeOne processing authorization, resolved baseline settings, candidate account/version support, reviewed gold answers, and a whole-experiment cost estimate within US$10. These are execution prerequisites, not facts established by this interview.

## Repository facts shaping the design

- The owner-only Accuracy extraction stack and customer ingest pipeline are separate. The named `need_extract` and `inventory_extract` stages belong to Accuracy.
- Current Accuracy parsing uses local text extraction followed by a routed LLM; its parse policy disables LlamaParse. `reference/README.md` contradicts the implementation and is stale on this point. Customer ingest also disables LlamaParse.
- Accuracy routing has code defaults but can use persisted settings and automatic provider fallbacks. The actual baseline must be established from resolved settings and call traces, not inferred from defaults.
- No BeOne-specific permission for processing by LlamaCloud was found in the repository. Evidence of authorization remains an execution prerequisite.
- Synapse validates source quotes as verbatim substrings of referenced parse blocks.
- Two independent BeOne reference packs exist. Current recall scoring is identifier-based; one pack has narrative gap answers without gap identifier targets, and the inventory extractor does not return the tactic identifiers expected by the scorer.

## Verified candidate documentation

Official documentation checked during the interview:

- [Extract configuration](https://developers.llamaindex.ai/llamaparse/extract/guides/configuring-extract/): `2.5` is documented as an Extract configuration version; do not describe it as a separate LlamaParse version.
- [Extract SDK inputs](https://developers.llamaindex.ai/llamaparse/extract/sdk/): original-file uploads, raw text supplied as a text file, and existing Parse job IDs are supported.
- [Response format](https://developers.llamaindex.ai/llamaparse/extract/guides/response-format/): field-level citations can include page and supporting `matching_text`. This does not prove that returned text will satisfy Synapse's block/quote validation; that requires a pilot.
- [Pricing](https://developers.llamaindex.ai/llamaparse/general/pricing/): costs depend on extraction tier and input type; text billing uses token-equivalent pages. Establish an actual batch estimate rather than using slide counts alone.

## Interview status

No open design questions remain. The user requested specification synthesis and publication using to-spec; that work is complete. No benchmark has been run, no document upload is authorized by the interview alone, and no deployed system has been modified. Execution prerequisites remain in the implementation spec.
