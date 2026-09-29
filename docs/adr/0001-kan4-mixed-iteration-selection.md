# ADR 0001: Selecting items across agent-loop versions

Status: Proposed — mixed selection design is under discussion; the temporary human-approval rule is agreed.

## Context

KAN-4 asks the judge to retain V0–V3 and avoid assuming the last revision is best. The user prefers allowing the judge to choose different versions of individual items. That can recover a strong earlier item without discarding improvements to other items. It can also create a combination never evaluated together: two individually sound gaps may duplicate each other, or a coverage decision may depend on a gap version that was not selected.

The S-numbered stages in KAN-4 refer to the legacy modular stack under `src/modules/`. The newer accuracy-first pipeline lives under `src/accuracy/` and names its steps by call kind (`need_extract`, `inventory_extract`, `coverage_decide`, `validation_gate`, and others). Its shared loop in `src/accuracy/kernel/agentic.ts` defaults to one critic/revision exchange, may stop before revising, and returns only the final draft and a string trace. `coverage_decide` and `coverage_critic` are separate call kinds rather than users of that shared loop. `src/accuracy/kernel/run.ts` records a call's final output and aggregate evaluations. Current records therefore cannot demonstrate that a mixed selection improves the full pipeline. The user's "three-agent loop" means proposer, critic, and judge roles; KAN-4's three critic/revision passes are a separate proposed execution depth.

## Proposed approach

1. Retain and evaluate every snapshot produced by an applicable agentic call. KAN-4's V0–V3 target depends on resolving the three-exchange question; local experiments add gold-standard scoring to the production loop's outputs.
2. Record each selected item's source snapshot, stable item identity, exact content/version, and selection reason. Record split/merge ancestry when identity is not one-to-one.
3. Treat the assembled selection as a separate call output. Run whole-set checks, including duplicates, references, provenance, and call-specific consistency.
4. In deliberate benchmark experiments, run downstream calls using that exact assembled output. Compare the complete pipeline result against a specified baseline on the same documents and gold pack; persist both results and evaluator versions.
5. In production, report observable checks and human review separately from benchmark accuracy. Item scores alone are not evidence that the assembled pipeline is better.

Deliberate local experiments run the same agentic process against an isolated copy of the specified starting knowledge-base state and a curated human gold pack. Calls may persist intermediate records inside that copy for end-to-end evaluation, but must not change the live production knowledge base. Repeats use independent starting copies and remain separate experiments.

Keep the gold pack evaluator-only. No proposer, critic, reviser, or judge prompt may receive the reference answers during an experiment; exposing them would invalidate the benchmark.

Compare exactly one, two, and three critic/revision passes locally before changing the production depth. Each pass count is a separate experiment on the same documents, gold pack, and evaluator version. Disable the current early exit for these controlled comparisons and evaluate every version: a one-pass run has V0–V1, a two-pass run has V0–V2, and a three-pass run has V0–V3. The ticket's V0–V3 acceptance criterion applies to the three-pass condition. Production continues at its current depth until the comparison supports a change.

A later pass is not eligible for production if it recovers a must-find item but also introduces a serious false or unsupported item; that regression must be fixed first. The user has asked whether additional passes should continue until the model is satisfied. Treat that as a future, bounded adaptive-loop hypothesis, not an agreed implementation. The model's self-assessment alone cannot establish completeness or safety, and KAN-4 explicitly defers early stopping until per-loop evidence has been collected.

When a later pass is otherwise admissible, prioritize recovery of valid gaps and tactics and correctness over added latency or inference cost. Benchmark experiments can measure these gains against gold; production can only use source-backed and reviewer signals. Keep cost and latency in the record so the choice remains explainable, but do not reject a valid recovery solely because it costs more.

Each critic pass must inspect the source blocks against the current gap and tactic inventory, not just critique items already present. Persist suspected omissions as structured issues with source file and block identity, item type, reason, severity, and later resolution status. The existing `auditCompletenessDetailed` function in `src/accuracy/modules/completeness-audit/engine.ts` already accepts blocks and claims and emits source-linked miss flags, so it is a starting point for per-snapshot checks. Its current rule treats a block as covered when any claim cites it, which can miss a second distinct need or tactic within the same block. Per-pass completeness checks must address that limitation. In production, such flags remain risk indicators; only local gold packs can establish true missed-item rates.

An important unresolved omission flag remaining after the allowed passes pauses production. A contributor can add the missing item or dismiss the flag with a recorded reason. Lower-confidence flags remain visible but do not block. Retain the source evidence and review action in the run history; a dismissal is not proof that the model's recall was complete.

An explicitly stated gap or tactic in a source block that is absent from the current inventory is an important omission. The blocking issue cites that block and describes the item. Inferred or ambiguous possible omissions are advisory until supported by clearer evidence. Severity depends on source evidence and effect on the plan, not the critic's confidence score alone; a contributor may reclassify a mistake with a recorded reason.

If the gap or tactic already exists in the knowledge base, link the new source block as additional provenance and resolve the omission without creating a duplicate entry. Clear identity matches may link automatically; ambiguous matches require contributor confirmation.

For model selection, benchmark the generated output before any human edits. Human editing becomes available only after a model has been chosen, in the live knowledge-base review flow. Do not use a human-corrected result as the model's own benchmark score.

Where an end-to-end model-selection benchmark crosses the accuracy-first `validation_gate`, use a fixed, recorded no-edit rule applied identically to each candidate model. This is an agreed benchmark design; it is not the current behavior of the live human gate.

## Agreed temporary production rule

Every live mixed output requires human approval before it is used as the selected output or passed to a downstream stage. Approval applies to the exact assembled output, not merely to its individual items. Record the reviewer's identity, decision, time, rationale, and the identity of the assembled output that was reviewed. A changed assembly requires a new approval.

For now, any contributor may approve; the Medical Affairs lead may also approve, while viewers cannot. The accuracy-first review API does not currently enforce this role rule, so implementation must authenticate the reviewer and authorize the decision.

If the reviewer rejects the assembled output, pause that call. Do not use the rejected output downstream or automatically substitute an earlier complete snapshot. A changed selection is a new assembled output and must pass its checks and receive its own approval before the call continues.

Deterministic failures that establish broken facts or references block approval until corrected. Examples include a missing source quote or a mapping to a nonexistent gap. A model-based semantic warning may be overridden by an authorized contributor, but the reviewer must record a reason and the warning and override remain in the history. A model judgment is advisory, not ground truth.

The accuracy-first `validation_gate` currently validates or rejects stored claims; it does not approve an exact mixed output before every agentic call uses it. The agreed rule requires a distinct approval point in the eventual implementation.

The user wants gaps and tactics to be present in the knowledge base before human review. Reviewers must be able to add missing records and edit individual records there. A human edit changes the selected assembly, so it must be recorded as a new revision with its author and reason, checked again, and approved as the exact revised assembly. Merely storing a proposed item in the knowledge base does not make it eligible for downstream use.

Use one knowledge-base entry per distinct gap or tactic. Keep its available agent-loop alternatives as versions in its history, where the reviewer can compare and select them. A genuinely new item receives a new entry; alternate wording for the same item does not create duplicate entries.

For a split, create a new entry for each distinct child and link each to the earlier combined item. For a merge, create a new entry linked to every predecessor. Retain the earlier entries in history; do not silently rewrite one identity to stand for several different ideas.

Link clear same-item versions automatically. If a rewrite may represent either the same item or a new one, require a contributor to confirm the link before combining their histories, and retain that decision in the audit trail.

Today, the accuracy-first extraction API writes `need_extract` gaps and `inventory_extract` tactics into `accuracy_claims` as unvalidated drafts before review. The table has no item-version history, and the shared agentic loop returns no intermediate drafts. The review flow must preserve the draft-versus-approved boundary while adding version selection and human edits.

## Consequences and open decision

This approach supports an explanation of *what was selected* and *why*. A full-pipeline comparison can show whether the assembled output performed better on the tested cases. It cannot guarantee improvement on unseen customer documents or assign a precise causal gain to every item choice without further controlled comparisons.

Only label a benchmark comparison as a performance improvement when document set, human reference pack/version, and evaluator version match. If they differ, show both results descriptively and do not attribute the score difference to the selection or prompt change.

For one matched pair, use "observed gain." Reserve "consistent improvement" for a pattern across repeated experiments with the same setup; each repeat remains a distinct experiment.

Still to decide: whether measured results warrant testing more than three passes or bounded adaptive stopping, and what number and summary of repeated runs support a claim of consistent improvement.
