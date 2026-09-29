# KAN-4 agent loop and evaluation design

**Status:** Design for KAN-30. This document describes current behavior, agreed KAN-4 behavior that is not implemented, and open decisions. It is not a claim that the proposed pipeline is live.

**Source:** [KAN-4](https://synapse21.atlassian.net/browse/KAN-4), [KAN-30](https://synapse21.atlassian.net/browse/KAN-30), the [domain model](../../kan-4-domain-model.md), and [ADR 0001](../../adr/0001-kan4-mixed-iteration-selection.md). The domain model and ADR remain working drafts; their open questions stay open here.

## Purpose and scope

The accuracy-first pipeline should make each agent-loop version inspectable, connect source-backed gaps and tactics to the output people actually use, and separate production quality signals from gold-standard experiment scores. The design applies to the newer call-kind pipeline under `src/accuracy/`, not the legacy S0–S10 modules under `src/modules/`.

KAN-30 defines the flow and terms. KAN-31–KAN-42 implement its parts; KAN-43 checks this document against the completed system. The design does not change production pass depth or approve a mixed output by itself.

## Roles and passes

The **proposer** produces an initial structured draft, V0. The **critic** examines that draft and its source evidence, recording specific problems, including plausible omitted gaps or tactics. The proposer acts as **reviser** when it answers the critic, producing V1, V2, or V3. The **judge** chooses the admissible result and records why. Three agent roles (proposer, critic, judge) do not mean three critic/revision passes; reviser is the proposer's second role.

**Current:** `runShallowAgenticCycle` defaults to one critic pass, exits before revision if its critic reports no issues at a high score, and returns a final draft plus a string trace. `coverage_decide` and `coverage_critic` are separate call kinds. The legacy S-numbered loop has three passes, but it is a different pipeline.

**Agreed, unimplemented:** Retain V0 and each revision actually produced, the structured critic findings, the findings' later fate, source links, per-version checks, per-transition regressions, judge choice, latency, token usage, and estimated cost. A judge may prefer an earlier admissible version. Production keeps its present depth until local experiments justify a separate change. Controlled one-, two-, and three-pass experiments produce V0–V1, V0–V2, and V0–V3 respectively; they disable early exit for that comparison only.

## Key records and boundaries

| Record | Meaning | State |
| --- | --- | --- |
| Source file and parse block | The input document and a stable source location used to check quotes and omissions. | Current store exists. |
| Call run | One execution of a call kind, such as `need_extract` or `inventory_extract`, within a production run or experiment. | Current module-run records exist; intermediate snapshots are not retained. |
| Snapshot | V0 or a produced revision, with exact output, critic issues, quality signals, and cost/latency. | Agreed, unimplemented. |
| Item version | One exact version of a gap or tactic, linked to its source and snapshot. Versions of the same distinct item belong to one knowledge-base entry. | Agreed, unimplemented. |
| Assembly | A selected set of item versions, possibly from different snapshots, with an identity and a reason for each choice. | Proposed mixed selection; exact-output approval rule agreed. |
| Review decision | An authenticated contributor's approval/rejection of an exact checked assembly, or a reasoned action on a finding. | Existing claim validation is narrower; assembly approval is unimplemented. |
| Experiment | One deliberate local run against a curated human gold pack and isolated starting knowledge-base copy. It may contain one or several call runs; every repeat is a new experiment. | Agreed, unimplemented as this KAN-4 record. |

The production knowledge base is the live workspace store. An experiment uses a separate copy of the specified starting state; intermediate writes stay in that copy. Its gold answers reach the evaluator only, never the proposer, critic, reviser, or judge. These boundaries prevent benchmark answers from leaking into generation and prevent test runs from changing customer data.

## Data flow and review states

1. Parse source files into source-linked blocks. `inventory_extract` and `need_extract` create tactic and gap drafts. **Current:** the extraction API inserts their final outputs into `accuracy_claims` as unvalidated drafts; it does not store every loop snapshot.
2. At each produced snapshot, check structure and provenance, inspect blocks against the current inventory for suspected omissions, and record structured critic issues. A block can contain more than one distinct missing item, even when another item from that block was already cited. **Agreed, unimplemented:** important, explicitly supported omissions block progression after the allowed passes; inferred possibilities remain advisory.
3. Revise and record whether each issue was resolved, partly resolved, left unresolved, or invalid. Record newly introduced errors, including lost source support or a previously correct item disappearing. **Agreed, unimplemented.**
4. Keep alternatives for the same gap or tactic in one knowledge-base entry. A genuinely distinct item gets another entry. Splits and merges retain predecessor links; uncertain identity matches require contributor confirmation. **Agreed, unimplemented.**
5. Select item versions, record their lineage and reasons, and check the whole assembled set for duplicates, broken references, invalid source quotes, and call-specific consistency. An assembly is a new artifact; good individual items do not prove the combination is sound. **Proposed selection behavior; checks and history unimplemented.**
6. Before a live mixed assembly is used downstream, an authenticated contributor or Medical Affairs lead approves that exact checked assembly. Viewers cannot approve. A failed deterministic check blocks approval; a semantic warning can be overridden only with a recorded reason. Rejection pauses the call without silent fallback. A changed selection or human edit changes the assembly identity and needs checks and approval again. **Agreed temporary rule, unimplemented.**
7. Pass only the eligible assembly to later accuracy-first call kinds. Record downstream run identity and the exact assembly consumed. **Agreed, unimplemented for mixed selection.**

The knowledge base may contain unapproved drafts so a contributor can review them. Draft presence is not downstream eligibility. After model selection, a contributor may add or edit a live gap or tactic with identity, reason, provenance, and new item-version history. That human-edited result must not be credited as the model's unedited benchmark result.

## One gap traced through the proposed flow

A parse block in a source deck states a regional comparator evidence need. The `need_extract` call's V0 omits it. The critic records a structured omission citing that source file and block. V1 adds a source-backed gap, and the issue is marked resolved; V2 changes its wording; V3 accidentally drops the citation. All produced versions remain visible, so the judge can select the supported V1 item rather than assuming V3 is best. The selected item version and reason enter an assembly with the other selected gaps. Whole-set checks confirm that the citation exists and that the gap is not duplicated. An authorized contributor approves the exact assembly; only then can the downstream mapping call consume it. If the contributor edits the gap, the edited version forms a changed assembly requiring checks and approval again. The example illustrates intended behavior, not an existing recorded run.

## Evaluation contexts

**Production, without gold:** Each produced version may expose source support, provenance validity, structural/domain checks, unresolved critic and completeness risks, human review actions, latency, tokens, and estimated cost. Human acceptance, edits, and rejection are operational feedback. None of these is measured precision, recall, or F1.

**Local experiment, with curated gold:** The evaluator additionally records item-level found/missed/partial/wrong outcomes and computes precision, recall, F1, or other reference metrics only where the pack supports them. Compare versions and downstream results using the same document set, gold pack/version, and evaluator version. A matched pair can show an observed gain; a consistent improvement requires separately retained repeats. Mismatched inputs or evaluators permit only descriptive side-by-side results. Persist reproducible inputs and outputs in Postgres and support complete JSON and bulk JSONL export.

## Open decisions and non-goals

- The exact source-set and change fingerprints needed for reproducibility and fair comparison remain to be specified before experiment persistence is implemented.
- The amount of repeated evidence needed to change production pass depth or call an improvement consistent remains open.
- More than three passes and adaptive stopping are later hypotheses. Model self-satisfaction alone cannot establish completeness.
- KAN-4 does not automate prompt promotion, turn production feedback into gold truth, or present production self-scores as accuracy.

## Evidence for the current-state labels

- `src/accuracy/kernel/agentic.ts`: current depth, early exit, final-only return.
- `src/accuracy/kernel/contracts.ts`: call kinds, roles, and upstream relationships.
- `src/accuracy/kernel/run.ts` and `src/accuracy/kernel/observability.ts`: module-run output, aggregate evaluation, and cost records.
- `src/app/api/accuracy/extract/route.ts` and `src/accuracy/store/claim-store.ts`: final extraction output inserted as draft claims.
- `src/app/api/accuracy/claims/validate/route.ts`: current claim validation endpoint.
