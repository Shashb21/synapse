# Roadmap date and dependency policy (KAN-85)

The roadmap (the Gantt timeline, stage S10) is a projection of the approved plan. It holds no judgement of its own: every date and every dependency comes from somewhere a person can see, and anything a model supplied stays marked as an estimate or a proposal until a person accepts it.

This page is the single policy for the customer timeline (`src/modules/stages/s10-timeline/`) and, where they overlap, the owner lab's Accuracy gantt (`src/accuracy/modules/gantt-project/`).

## What goes on the roadmap

| Tactic or activity | On the roadmap? | How it is shown |
| --- | --- | --- |
| Planned or ongoing, mapped to a live gap | Yes, as committed work | Normal bar |
| Completed | Yes, as historical evidence | Hatched bar, "Completed — historical evidence" badge, "Completed" under its dates. It is not future execution. |
| Proposed (not yet approved) | Yes, but not as part of the plan | Faded, dashed bar, "Proposed — not yet in the plan" badge |
| Cancelled | No | Counted and named under the timeline ("N cancelled tactics not in the plan") |
| Rejected in review | No | — |
| Removed from the timeline by hand | No, until added back | Listed under "Removed by hand" |
| Accepted tactic expansion | Yes, as its own activity (`ACT-EXP-…`) | Under its parent tactic |
| Mapped tactic with missing dates | Yes, as "Unscheduled" | Listed with the missing fields; blocks a final save |
| Open gap with no tactic | Yes, as an unscheduled gap | "Open gap with no mapped or ideated tactic yet" |

Workshop outcomes (stage 7, KAN-84) are deferred: accepted Tactic Ideation (S9) proposals feed the roadmap directly.

**One activity per tactic.** A tactic that answers several gaps is one activity (one set of dates, one set of dependencies); it is drawn under each of its gaps, and every row points to the same activity id.

**Lane rule.** An activity's lane is the highest band a person validated (S8) across the open gaps it answers. A suggested band never places an activity. If none of its open gaps has a validated band it sits in "Not yet prioritized"; if all its gaps are addressed it sits in "Addressed evidence". A person can move it to another lane by hand (lane locked), or hand it back to the band.

## Where a date comes from

Each date (start, end, readout) carries its source in `meta.schedule_basis`.

| Source | Meaning | Shown as |
| --- | --- | --- |
| `human` | A person entered, moved or accepted it | "set by hand" |
| `tactic` | The tactic record's start date or evidence-available date | "from the tactic" |
| `design` | The accepted S9 study design's duration or readout lag | "from the study design" |
| `model` | A model estimated it because nothing else supplied it | "model estimate", amber dashed outline on the bar, "Estimate" badge |
| `saved` | Saved before the source was recorded | "unknown source", never presented as a fact |

**Precedence.** A saved date (a person's, or an earlier build's) always wins and is never moved by a rebuild. Otherwise: tactic, then design, then model estimate. A start the model estimated is laid out after the readouts of the activities it is accepted or proposed to wait on. Nothing saved is ever shifted automatically.

**Estimates are reviewed.** A person accepts an estimate ("Accept estimate" on the activity, or "Accept N estimates" for all) or edits the date; either makes the date `human`. When an activity's inputs change after an estimate was made (its tactic's dates or status, its design timing, or its gaps), the estimate is flagged "out of date". Neither unreviewed nor out-of-date estimates can be saved as final.

## Dependencies

- **A person's dependencies** (set in "Dependencies", or a proposal they accepted) gate the schedule. They are marked `depends_locked`, and a rebuild never asks a model about that activity again.
- **A model's dependencies are proposals.** The model is asked only about activities that are new or whose inputs changed since it was last asked, and never about locked ones. Its answers are stored in `meta.proposed_dependencies`, shown as "Proposed by the model — not yet a dependency", and gate nothing (no conflicts, no scheduling, not in the saved plan's dependencies) until a person accepts each one. A rejected proposal is kept in `meta.rejected_dependencies` and never proposed again for that activity.
- **Rows saved before this policy** kept a model's dependencies as facts. Unless a person had locked them, they now show as proposals to review.
- **AI off.** A rebuild never asks the model and never changes any dependency or proposal.
- **Inferred from sharing a gap** (Accuracy gantt only: a dissemination tactic after the work it reports, a sub-gap's tactic after its parent's) is also a proposal: kept in `proposed_depends_on`, it shifts no dates.

## Checks before a final save

A draft can be saved at any time. A final save is refused, with a plain-English list (also shown above the chart as "Before this can be saved as final"), while any of these are open:

1. An activity with no schedule (unscheduled).
2. A **finish-to-start conflict**: a successor starts before the activity it waits on ends. (The timeline does not distinguish readout-gated links, so conflicts use the predecessor's end; the layout of estimated starts uses the readout when there is one.)
3. A **dependency loop** in saved data.
4. A **dependency on an activity that is not on the timeline** (removed, undated or unknown).
5. An **invalid date**: not YYYY-MM-DD, end before start, or readout before start.
6. An **unreviewed or out-of-date model estimate**.
7. An **unreviewed proposed dependency**.

Self-dependencies and cycles are refused when a person sets or accepts dependencies. The build reports loops and dangling dependencies (`problems`) instead of ignoring them.

## Saved versions and export

Saving freezes a numbered snapshot of every activity, lane, dependency, unscheduled and cancelled item, the problems list, and a **fingerprint** of the activities (`planFingerprint`) with a short code (`fingerprintCode`). "Changed since the last save" compares fingerprints.

"Export PNG" stamps the image with what it shows and its fingerprint code ("Synapse IEGP · Saved v3 final · fingerprint 1a2b3c4d") and names the file the same way (`synapse-iegp-v3-1a2b3c4d.png`). When the live plan differs from the last save, the export is labelled "Current plan (not saved)". "Show: Saved vN" opens a saved version read-only, so its chart can be exported exactly as it was saved.

## Roles and audit

Every change goes through `/api/plan` with a role check (`validate` to edit, accept estimates and review dependencies; `save_final` to save as final) and writes an edit record with a rationale: `schedule`, `lane`, `depends_on`, `proposed_dependency` (accept or reject), `schedule_basis` (estimate accepted), and the plan's `status`.

## Where the Accuracy gantt differs, and why

The Accuracy gantt is the owner lab's projection of the claim ledger (`/admin/accuracy/timeline`), not the customer roadmap.

- It uses no model. Its only inferred dependencies come from shared gaps, and they are proposals (`proposed_depends_on`) that shift no dates. There is no review step in the lab; proposals are recorded in the snapshot for reference.
- Dependencies recorded on a tactic claim gate dates; tactics whose dates a person locked are never shifted.
- Undated tactics are omitted rather than listed as unscheduled, because the lab measures extraction accuracy, not plan completeness.
- Its final save requires every bar to bind to a validated tactic and is refused when there is a dependency loop or a dependency on a bar not on the chart (`ganttProblems`). It does not block on proposals, since the lab has no review step.
- Snapshots carry a content hash (`hashGanttSnapshot`) and an audit bundle.
