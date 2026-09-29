# KAN-4 domain model (working draft)

This document records terms and decisions agreed during the KAN-4 design interview. Open questions are deliberately left open rather than treated as requirements.

## Agreed terms

### Experiment

An experiment is **one deliberate local/offline run with a curated human gold standard**, using a specific set of source documents and a specific set of changes to prompts or other run inputs. A second run, even with the same documents and settings, is a separate experiment. This makes repeated runs visible rather than overwriting their history.

The gold pack is visible to the evaluator only. The proposer, critic, reviser, and judge must not receive the reference answers during the run; otherwise the resulting scores would measure access to the answer key rather than extraction quality.

Rerunning only one call kind (for example, `need_extract`) with a changed prompt is a new experiment.

An experiment may run the full pipeline. In that case, it contains several call runs within the same experiment. An experiment may also contain just one call run, such as a `need_extract`-only rerun.

Each deliberate experiment starts from an isolated copy of its specified knowledge-base state. Its stages may write intermediate gaps, tactics, and mappings into that copy so a full pipeline can be evaluated. Those writes do not change the live production knowledge base. Each repeat starts from its own copy; experiment history is retained separately.

During model-selection experiments, humans do not edit the generated output. The evaluation measures the unedited model result. Human editing of gaps and tactics begins after a model has been chosen, in the live knowledge-base review workflow.

### Call run (formerly called a stage run in this draft)

One execution of a call kind within an experiment or production run. In the accuracy-first pipeline, examples include `inventory_extract`, `need_extract`, and `coverage_decide`. For a call using the shared agentic loop, V0 is its initial proposal and later versions are revisions. KAN-4 asks for V0–V3 after three critic/revision exchanges, but the current accuracy-first loop defaults to one exchange and may stop before revising. The agentic loop is a production quality process; local gold-standard experiments measure its outputs.

### Three-agent loop

The user means the **proposer, critic, and judge roles**. The proposer also revises in response to the critic. The number of critic/revision passes is a separate choice. The accuracy-first implementation currently defaults to at most one pass; KAN-4 requests three passes to expose V0–V3, but that depth has not been agreed for production.

Local gold-standard experiments will compare exactly one, two, and three passes. Each pass-count condition is a separate experiment using the same documents, gold pack, and evaluator version. The current early exit must be disabled for these controlled comparisons so each run produces its intended versions (V0 through V1, V2, or V3), and each version is evaluated. Production keeps its current pass depth until the comparison supports a change. The ticket's requirement that every evaluation run have V0–V3 therefore applies to the three-pass condition, not to a one- or two-pass comparison run.

A pass that recovers a must-find item but introduces a serious unsupported or false item is not eligible for production until that regression is fixed. Recovery, regressions, latency, and cost are compared after this guardrail.

After excluding serious regressions, recovering valid gaps and tactics and improving output correctness take precedence over latency and inference cost when choosing production depth. Local gold-standard experiments can measure this with item-level reference results. Production uses source support, completeness issues, deterministic checks, and human review instead of claiming gold-standard accuracy. Continue recording latency and cost so the tradeoff remains visible.

More than three passes and adaptive stopping are possibilities to investigate after the first per-loop measurements. A model's own statement that it is satisfied is not sufficient evidence to stop or approve an output; any adaptive policy needs an upper bound and checks for unresolved issues and newly introduced regressions.

At each critic pass, compare the source blocks with the current gap and tactic inventory to look for omitted items. A suspected omission becomes a structured issue identifying the source file, block, proposed gap-or-tactic type, and reason. Track whether the next revision resolves it, partly resolves it, or shows that it was an invalid finding. In production this is a recall-risk signal, not measured recall; local gold-standard experiments can determine whether the suspected item was truly missed.

After the allowed passes, an important unresolved missing-item issue pauses the production run for a contributor to add the item or dismiss the issue with a reason. Lower-confidence issues stay visible for review without blocking progress. The review decision and the source evidence remain in the run history.

A gap or tactic explicitly stated in the source but absent from the current inventory is an important omission and blocks progress after the allowed passes. The issue must cite the exact source block and explain the missing item. More interpretive possibilities remain nonblocking warnings unless further evidence makes them clear. A contributor may correct an incorrect classification with a recorded reason.

If an equivalent gap or tactic already exists in the knowledge base, resolve the omission by linking the new source evidence to that entry. Do not create a duplicate. The match follows the same identity rule as revisions: link clear matches automatically, and ask a contributor to confirm ambiguous ones.

### Mixed selection (proposed)

A selected call output may contain individual items taken from different available snapshots. This is a user preference under design, not yet an accepted release rule. The mixed output is a new assembled artifact: it is not identical to any one snapshot and must be evaluated as a set before its quality can be claimed.

Each selected item needs lineage: which call run, snapshot, and item version supplied it, plus the judge's reason for selecting it. Splits and merges may require links to more than one earlier item.

For now, a live mixed selection requires human approval of the exact assembled output before that output is used or passed to another stage. A later change to the assembly invalidates that approval.

Any contributor may approve for now; the Medical Affairs lead may also approve, while viewers may not. This authorization rule must be enforced in the accuracy-first review path.

If a reviewer rejects the mixed selection, the call pauses. It does not automatically fall back to an earlier complete snapshot. A revised selection needs checks and a new approval.

**Blocking check:** a deterministic test of a required fact or structure, such as a source quote existing or a mapping pointing to a real gap. A failed blocking check must be corrected before approval.

**Advisory warning:** a model-based semantic judgment that may be uncertain. An authorized contributor may override it with a recorded reason; the warning and override remain visible.

### Knowledge-base review

Generated gaps and tactics must already be in the knowledge base when the human reviewer begins. The reviewer can add a missing gap or tactic and edit individual existing records there. These actions need their own provenance and evaluation history; editing a selected item changes the assembled output and requires its checks and approval to run again.

Each distinct gap or tactic has one editable knowledge-base entry. Different available versions of that same item are kept in the entry's history for comparison and selection, not shown as separate duplicate entries. A genuinely new gap or tactic gets a new entry.

If one item splits into several distinct items, each child gets a new entry linked to the earlier item. If several items merge, the merged item gets a new entry linked to all of its predecessors. Earlier entries stay in history so the change is explainable.

Clear matches between versions may be linked automatically. When it is uncertain whether a revision is the same item or a new item, show the proposed link to a contributor for confirmation before joining their histories. Keep the proposed match and the human decision in the audit record.

Presence in the knowledge base does not by itself mean a mixed selection is approved for downstream use. Review state and downstream eligibility must be explicit.

### Production run

An ordinary customer run is a production run, not an experiment. Its agentic loop aims to reduce missed items and records no-gold quality signals for every version actually produced. Gold-standard precision, recall, and F1 belong only to local experiments with a curated reference pack. Production signals can flag risk but cannot prove nothing was missed.

### Experiment comparison

A performance-improvement claim requires the compared experiments to use the same document set, the same human reference pack and version, and the same evaluator version. If any of those differ, show the results side by side as a descriptive comparison without attributing the difference to the prompt or other tested change. The exact input and evaluator identities must be retained with each run so this rule can be checked.

One matched pair of runs can report an **observed gain** on that pair. Describe an improvement as **consistent** only when repeated, separately recorded experiments with the same setup support it. A repeat is a new experiment, not an overwrite of the first.

## Relationships to settle

- How the exact document set and changes are identified so that a run can be reproduced and compared with another run.
- What local experiment evidence is sufficient to change production pass depth while preserving the agreed quality-first rule.
- Whether the measured one-to-three-pass results justify testing a bounded adaptive loop or additional pass counts later.
- How many repeated runs, and what summary of their variation, are useful before describing an improvement as consistent.

Source: [KAN-4](https://synapse21.atlassian.net/browse/KAN-4) and the user's definition of an experiment in this interview.
