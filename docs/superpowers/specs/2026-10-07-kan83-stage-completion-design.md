# KAN-83: complete existing extraction, assessment, split, and prioritization stages

Status: written design for user review; no implementation approved or performed.

Source baseline: freshly fetched `github/main`, commit `3eb28c1`, inspected in `/private/tmp/synapse-stage-review-20261007`. The controller confirmed this matches main. Jira dependency KAN-17 is still To Do and owns retiring the legacy priority path.

## Intended result and boundaries

Complete the existing workflow so a reviewer can see source-backed structured gaps and inventory tactics, inspect every eligible gap–tactic assessment, derive consistent status, apply a validated partial split, and prioritize validated open gaps with the existing configurable S8 model. “Source-backed” means each claimed fact has a traceable quotation or reference to the material that supports it. Unknown information remains explicitly unknown.

This changes stage contracts and persistence boundaries, so it is architectural work. This document is a design, not an implementation plan. Written-spec approval permits preparing the implementation plan; implementation requires its review and an execution-method selection under the brainstorming workflow.

KAN-83 reuses existing UI, source matching, validation, and history owners. It does not redesign their screens, replace source matching, implement a new history product, or retire legacy priorities. KAN-17 remains a dependency for retirement, not a reason to postpone reuse of S8 scoring.

## Alternatives and recommendation

1. **Extend existing owners with explicit adapters (recommended).** Keep Accuracy extraction and coverage persistence as their current owners; adapt S6's proposal/confirmation boundary and S8's scoring and placement rules to Accuracy claims. Extract small reusable services from these owners where needed. This preserves established human locks and avoids competing status or priority definitions. It requires deliberate adapters because the stores and status vocabularies differ.
2. **Implement parallel Accuracy split and priority engines.** This initially limits edits to Accuracy, but duplicates S6/S8 validation and rerun rules and creates another priority implementation while KAN-17 is still retiring one. It increases semantic drift and maintenance cost; reject this option.

Do not call an existing module unchanged if it reads a different store. In particular, S8 currently uses `loadState()` and workspace-scoped `priority_placements`; Accuracy uses shared database tables keyed by `workspace_id`. Reuse their rules through an explicit store/context adapter, rather than treating matching IDs as shared identity.

## Current owners and concrete gaps

| Owner | Current behavior | KAN-83 responsibility |
| --- | --- | --- |
| `src/accuracy/modules/need-extract/{module,prompts}.ts` | Extracts statement, external ID, provenance; fresh IDs each run; prompt cuts text at 40,000 characters | Structured facts, explicit unknowns, bounded source pages and stable rerun identity |
| `src/accuracy/modules/inventory-extract/{module,prompts}.ts` | Extracts name/type/status/evidence question; same prompt truncation | Structured tactic detail and evidence-backed lifecycle without fabricated defaults |
| `src/app/api/accuracy/extract/route.ts` and `claim-store.ts` | Inserts each returned claim and metadata | Preserve structured fields, stable upsert, human locks, validation freshness |
| `src/accuracy/store/coverage-store.ts` | Loads at most 500 claims, falls back to three tactics, returns first 80 heuristic pairs plus manual decisions | Complete paged pair universe, canonical assessments and provenance |
| Accuracy `coverage-decide`, `coverage-queue`, and coverage routes | Pairwise schema already distinguishes full/partial/limited/not relevant; assist returns a suggestion; UI conversion collapses limited into partial | Reuse pair evaluation and manual confirmation; preserve canonical Limited without loss |
| `src/modules/stages/s4-kg-mapping/module.ts` | Mapping dialogue, dimensions, reviewer rejections, `max_per_gap` cap | Reuse evidence/dimension rules and human rejection protection; remove cap as an assessment-completeness rule |
| Accuracy `status-derive` and `src/lib/iegp/engine.ts` | Two status implementations disagree | One pure shared status rule with store-specific adapters |
| Accuracy `partial-split/module.ts` | Fabricates child ID output; priority returns no placements | Wire real split and S8 services |
| S6 and `src/lib/iegp/store.ts::splitPartialGap` | Source-aware split proposal and human apply; sequential writes create children, copy links, add versions, retire parent | Reuse confirmation semantics and history boundaries; make Accuracy apply atomic |
| S8 `module.ts`, `axes.ts`, `axis-math.ts` | Configurable axis scoring, quadrant bands, manual placements and validation locks | Reuse scoring, bands, rationale and lock semantics through Accuracy adapters |

## Structured extraction and source completeness

Add versioned structured fields while retaining existing `statement`, `external_id`, tactic name/type/status/evidence-question and provenance. A field carries a value, `known` or `unknown` state, supporting spans, and an unknown reason when needed. For example: `owner = { state: "unknown", value: null, reason: "not_stated", provenance: [] }`. Absence is not evidence that a field is false or empty.

Gap fields: description, indication, disease setting, category, rationale, supporting-document references, and interview quotations with attributed speaker and role when stated. A quote's attribution is separately unknown if the source supplies the quotation but no speaker. Document references retain stated titles/IDs and resolution state; do not invent a file link when an attachment is unavailable.

Tactic fields: description, objective, owner, timing, and outputs. Timing preserves stated milestones or ranges without manufacturing dates. Inventory lifecycle is a known source-backed enum or explicit unknown; unknown lifecycle never counts as committed. Do not map absent status to planned or completed. Preserve the current enum for known values and introduce a versioned unknown representation through the adapters.

Reuse `quote-validator.ts` against actual blocks, source-workspace checks and existing source-stakeholder attribution in `parse-store.ts`. Validate each known factual field, not just the record's overall statement. Invalid quotes fail that candidate's acceptance and are reported; rejected candidates and unread source must remain distinguishable from “no gaps found.”

Replace `.slice(0, 40_000)` with stable source pages assembled within a configurable prompt budget. Record source/block revision, expected units, processed units, oversized-unit subdivisions, failed pages and next cursor. Preserve quote offsets/block identity when subdividing. Resume failed pages without reinserting accepted candidates. An explicit selected-block request is complete only for its declared selection, not the whole source. Parse dropped units remain visible as upstream incompleteness. A missing or truncated model response leaves the page incomplete; never report exhausted source based on a partial response.

Stable extraction keys use workspace, source revision, claim type and source-backed entity identity. Existing source-matching/merge owners resolve candidate identity across revisions; KAN-83 does not add a competing fuzzy matcher. A same-revision rerun returns/upserts the same claims. Model updates respect `human_locked`; conflicts become reviewable suggestions. Old records receive unknown structured fields on read, not inferred facts or blanket re-extraction. Changes to factual input invalidate dependent validation according to existing stale-validation policy while retaining the actor and original decision history.

## Complete coverage assessment

The eligible universe is the Cartesian product of active eligible gaps and active inventory tactics in the workspace. Apply existing review/exclusion/retirement rules explicitly; record exclusion reasons. Proposed inventory tactics can be assessed for relevance but cannot close gaps. Ideated tactics are not silently counted as source inventory. Missing provenance or unknown lifecycle is a visible pending reason rather than a reason to hide the pair.

Snapshot both entity IDs and revisions. Page this universe in deterministic ID order with a cursor tied to that snapshot. A page size limits one response, not total work. Remove the top-three fallback, 80-row slice, fixed claim-limit dependence, and `max_per_gap` suppression from assessment completeness. S4 may use relevance ranking to order work; it cannot omit low-ranked pairs. Every included pair has an explicit state: pending, full, partial, limited, or not_relevant. Model omissions/errors remain pending. Human-rejected pairs remain visible as protected decisions or a pending-with-rejection state if their historical record lacks a canonical assessment; a rejection alone must not invent not_relevant.

Extend `coverage-store.ts` as the single Accuracy persistence boundary. Use a unique workspace/gap/tactic key, revision-aware writes, assessment rationale, dimensions, confidence, evidence references, actor/run provenance, validation and freshness. Keep pending separate from an accepted not_relevant verdict. Preserve canonical Limited in storage/API; the old UI “partial” label may remain a presentation adapter but cannot replace it during round trips. Existing `covers` maps to full, `none` to not_relevant, and `unknown` to pending. Ambiguous legacy partial remains partial; it cannot be reconstructed as limited. Legacy accepted decisions retain human protection. Missing legacy revision metadata is marked freshness unknown and requires revalidation before contributing to new status computation.

Reuse `coverage-decide` and the manual coverage endpoint. The model produces a suggestion, not human validation. Reuse S4's dimensions and rejection/lock behavior without importing its gap-level model status as authority. Evidence is restricted to permitted source blocks and validated references; no source-less model verdict becomes validated coverage.

Persist completeness counts independently of the displayed page: eligible total, assessed total, validated current total, pending, stale, failures, and exclusions. A run is assessed-complete only when every eligible pair in its snapshot has an assessment; validation completeness is a separate count. New/changed entities invalidate the snapshot and create explicit work, without deleting old decisions. Resuming targets pending/failed pairs; protected decisions and same-revision successful assessments are not overwritten.

## Shared status rule

A pure shared function accepts normalized assessment, lifecycle and validation/freshness inputs; adapters map its result to Accuracy `open/partial/addressed` and plan `validated_open/validated_partial/validated_addressed`. Candidate/excluded review states stay outside this mapped-status calculation. Plan coverage means planned work may address the evidence need; it does not claim completed clinical evidence.

| Current validated coverage from committed planned/ongoing/completed tactics | Computed status |
| --- | --- |
| None, pending, unknown, not relevant, or only proposed/cancelled tactics | Open |
| At least one Full | Addressed, even when another tactic is Limited or Partial |
| Partial or Limited, with no qualifying Full | Partial |

Only current validated assessments contribute. Several Partial assessments never sum to Full. Retain human overrides, rationale, actor and stale markers; show computed and effective status separately. A stale override remains visible according to existing override semantics, but cannot silently become fresh validation for splitting or prioritization.

Existing Accuracy tests explicitly expect proposed-only Full to be Partial and Full plus Limited to be Partial; these assertions must change. `tacticCountsTowardAddressing` currently permits a proposed publication when `evidence_available` is set. Select the ticket's lifecycle invariant: proposed and cancelled never address. Published evidence may support assessment, but never bypass lifecycle. Remove the exception from status contribution through the shared rule. Preserve the separate published-literature helper where it is used to describe evidence availability.

## Real partial split and atomic apply

Keep S6's propose/critic/judge and separate human-confirmed apply boundary. Adapt it to Accuracy parent fields, current validated coverage and provenance. Proposal output contains addressed/residual statements, supported addressed tactic IDs, uncovered dimensions, rationale, source references and input revision. The addressed child describes only the slice supported by those tactics; the residual is a nonempty, distinct evidence need. Unknown dimensions must not become invented residual facts.

Applying requires authenticated actor/rationale, an active currently validated Partial parent, unchanged parent/coverage revisions and at least one committed tactic supporting closure of the addressed slice. Recheck inside the transaction. Proposal acceptance by a model is insufficient. Existing human overrides do not bypass evidence checks.

An atomic transaction means all writes succeed together or none become visible. In the Accuracy store, one transaction creates both children and lineage, copies supporting source/need references, writes explicitly validated slice coverage, records version/audit events, retires the parent, and creates residual work for assessment/prioritization. Preserve original parent evidence as inherited context, distinguishing it from evidence that directly supports each child's statement. Do not copy parent Full/Partial blindly to both children; residual inherited coverage stays pending unless independently validated. Children do not inherit the parent's priority validation.

Use a unique operation key plus expected parent revision: a retry returns the same two child IDs; a conflicting second apply fails. S6's existing store function performs sequential writes and is not an atomic primitive to call unchanged. Reuse its domain checks/version conventions through a transaction-aware service and an Accuracy persistence adapter. Reuse existing history/version owners for rollback: restore the exact pre-split parent snapshot and retire the children/derived decisions in one transaction. Block rollback if descendants have later human edits until those changes are explicitly resolved. No external model request runs inside a database transaction.

## S8 prioritization integration and compatibility

Replace Accuracy's empty priority stub with a thin adapter to S8 scoring and placement services. Select only active, currently human-validated Open gaps or residuals; addressed and stale-unvalidated gaps are reported as skipped. Load saved axis configuration and chosen setting/axis pair; preserve S8's distinction between a suggestion and a working human-validated band. The current S8 bands are High/Medium/Low/**Defer** and depend on two-axis quadrants, not the legacy weighted thresholds. Extend Accuracy's output to retain Defer; never silently coerce it to Low.

Provide structured source-backed context covering strategic fit, clinical/patient impact, payer relevance, guideline evidence, unmet need, competitive differentiation and feasibility. Extend prompt/context shape and configurable axis catalog only as necessary; reuse saved user configuration and current axis direction rules. These considerations inform the configured scores/rationale rather than impose a second hidden weighted formula. Each consideration records known evidence or an explicit missing-context statement. Return finite 0–100 axis scores, saved configuration revision, suggestion/working band, rationale and supporting references. A materially unsupported score remains an unvalidated suggestion with its limitation, never a fabricated fact.

Reuse S8's validation, `human_axes`, `human_band`, manual edits and rerun protections. Refresh model-owned suggestions without overwriting protected human scores/bands. Revalidate when decision inputs/configuration materially change under the existing stale-validation owner. Accuracy persistence must include workspace identity; do not write shared Accuracy IDs directly into unscoped S8 placements or assume `loadState()` contains them.

KAN-17 remains To Do. Keep existing legacy mirroring and consumers functioning where they already apply. KAN-83 reuses S8 without deleting `mirrorLegacyBand`, removing legacy tables, rewriting old priorities, or redirecting unrelated consumers. The adapter stores Accuracy placements through a workspace-aware owner; KAN-17 can later retire legacy publication separately.

## Failure handling and verification contract

Malformed input, cross-workspace IDs, bad provenance and stale revisions fail with specific actionable errors before write. Model/API failure preserves prior successful results and pending work with a resume cursor. Unique constraints handle concurrent retries; transaction failure rolls back complete split/decision units. Reruns do not overwrite human decisions. Run records distinguish partial success, complete assessment, and complete validation.

Verification during implementation uses the repository's TypeScript/Vitest and existing API/e2e harness, not a new Python test layer. Arrange/Act/Assert means prepare a scenario, perform the action, then check the observable result. Extend existing extraction, quote, coverage queue/assist/schema, status, manual-edit and S6/S8 tests with:

- Structured known/unknown fields, speaker attribution, invalid quotes, unresolved supporting documents, unknown lifecycle and backward-compatible old records.
- Sources exceeding 40,000 characters, oversized blocks, selected-block scope, failures/resume, and same-revision reruns preserving IDs and human fields.
- More than 80 pairs and 500/1,000 claims, a relevant tactic beyond the first three and beyond former per-gap caps, explicit not_relevant, pending omissions, page exhaustion, changed snapshots and concurrent deduplication.
- Shared status table across both adapters: proposed publications with evidence stay Open; Full plus Limited is Addressed; many Partial remain Partial; stale/unknown validation and overrides remain distinct.
- Confirmed split persistence, provenance inheritance, no invalid residual closure, failure injection between writes, repeat apply, concurrent revision conflict and blocked/successful rollback through the history owner.
- S8 configured axes/direction/quadrants including Defer, context provenance, missing context, finite scores, validated-open eligibility, human locks, dry runs and rerun idempotency.

Run the smallest affected Vitest suites, relevant API/e2e tests, typecheck and lint when implemented. No tests were run for this read-only design; source inspection is design evidence, not implementation verification.

## Checks to settle in the implementation plan

Confirm the exact existing source-match, freshness and history extension points and their ticket ownership before assigning files; no replacement mechanism is authorized here. Confirm transaction-aware database connection propagation across Accuracy and workspace stores; if they cannot share a transaction, keep the split wholly in Accuracy with explicit adapters rather than a non-atomic cross-store write. Confirm placement schema scoping and migrate only the additive Accuracy contract needed for isolation. Enumerate all shared-status callers, including the legacy optional-tactics overload and split-child shortcuts, so no caller bypasses lifecycle or freshness accidentally. Review these concrete boundaries in the plan before product changes.
