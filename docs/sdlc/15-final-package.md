# Final IEGP package (KAN-86)

Saving the plan as final freezes the complete Integrated Evidence Generation Plan as one version. A final contains:

1. the Evidence Gap Inventory;
2. the Evidence Tactics;
3. the Prioritisation;
4. the Roadmap;
5. the open items and limitations.

Every part comes from the same revision of the workspace. The saved package is read back only from the frozen JSON. Live edits never change it; saving again makes a new version.

Code: `src/modules/stages/s10-timeline/final-package.ts` builds the package and `savePlan` in `module.ts` freezes it. `final-view.ts` reads it back.

## When a final can be saved

The roadmap checks in [14-roadmap-policy.md](14-roadmap-policy.md) come first. These cover undated activities, conflicts, loops, missing references, invalid dates, unreviewed estimates and proposed dependencies.

The complete plan then also needs every one of these:

- **No candidate gap:** every live gap is decided, kept as Open or Addressed, or excluded.
- **No Partially Addressed gap:** each one is split, or rewritten as Open or Addressed.
- **Every live gap confirmed:** `human_validated`.
- **Every Open gap banded:** each has a validated priority band on the Prioritization Matrix.
- **No orphans:** nothing points at a retired or missing gap (`findGapOrphans`, KAN-97).
- **No outside references:** no roadmap activity points at a gap or tactic outside the workspace.

Each refusal is a plain-English list naming the gaps. Some items do **not** block a final. The package lists them under open items instead:

- unscheduled gaps;
- Open gaps with no tactic yet;
- deferred gaps;
- parked gaps;
- excluded gaps.

A draft can always be saved, and it does not carry a package.

## Format

The format is `schema_version: "iegp-final/1"`, stored at `iegp_plans.snapshot.package`. The record's existing timeline fields stay alongside it, so the timeline view, the saved-version chart and the PNG export work unchanged.

| Field | Contents |
| --- | --- |
| `plan_context` | Asset (name, INN, indication, geography), the planning context as entered, and the strategic objectives. |
| `evidence_gap_inventory[]` | Every live gap, whatever its status or band. Each gap carries: <ul><li>wording and domain, effective status, any override (status, reason, by whom), settings and metadata;</li><li>its objective, and its confirmation (who, when, why);</li><li>parked state, parent or origin gap;</li><li>its needs, with source document, quote, block, run and S2 candidate references;</li><li>its coverages, with overall rating, rationale and dimensions;</li><li>its residuals and its priority.</li></ul> |
| `evidence_tactics[]` | Every tactic, with: <ul><li>description, evidence question, objective (from the gaps it answers), owner, function;</li><li>timing (start date, evidence available), outputs (intended use);</li><li>lifecycle status, and `evidence_state`;</li><li>`origin`: source document, recorded by hand, accepted from Tactic Ideation, or added by hand;</li><li>the gaps it answers, and its expansions.</li></ul> |
| `prioritisation` | The matrix axes, the axes plotted, and each live gap's placement (band, validated, axis scores, rationale, who validated it). |
| `roadmap` | Activities as frozen (dates with their schedule source, dependencies, inclusion, lane), window, lanes, pending, removed and cancelled, plus the KAN-85 roadmap fingerprint and code. |
| `open_items` | Unscheduled, unaddressed, deferred, parked and excluded gaps, and `limitations[]`. Limitations always include the workshop line, and say how many tactics are still planned, ongoing or proposed. |
| `workshop_outcomes` | `{ status: "none", note: "Workshop outcomes: none (workshop not in use)" }`. Workshops are parked (KAN-84); accepted Tactic Ideation proposals are the source of new tactics. |
| `lineage` | Source ids, recent module runs (id, stage, start time, status), and the S2 run ids the needs came from. |

**Planned work is never shown as evidence.** `evidence_state` takes one of these values:

| Value | Meaning |
| --- | --- |
| `completed_evidence` | The evidence has been generated. |
| `ongoing_work` | Work is under way; the evidence is not yet generated. |
| `planned_work` | Work is planned; the evidence is not yet generated. |
| `proposed_not_committed` | Proposed, not yet committed to the plan. |
| `cancelled` | Cancelled. |

The page labels them the same way.

## Version and fingerprint

- **Version:** allocated inside the save transaction under a per-workspace advisory lock. Two saves made at the same moment get different numbers, and a failure part-way writes nothing.
- **Fingerprint:** `snapshot.package_fingerprint` is the sha256 of the canonical JSON of the whole package, with object keys sorted at every depth.
  - `built_at` is left out of it: when the package was assembled is not part of what was approved, and the record keeps its own `saved_at`.
  - Any material change gives a different fingerprint, whether to a gap, a need quote, a tactic, a band, a roadmap date or a limitation.
- **Record:** the save is written as an edit record (and so into the platform audit log), including the full fingerprint.
- **Integrity check:** the readable view recomputes the fingerprint. It warns if the stored package no longer matches.

## Reading it

- **Page:** `/plan/final?version=N` shows the five deliverables. Without a version, it shows the latest final. The timeline links to it once a final exists.
- **Export:** `GET /api/plan/final/N` returns the same frozen version as JSON, for workspace members only.
  - Signed out: 401.
  - A version this workspace does not have, including another workspace's: 404.
  - A non-numeric version: 400.
- **Chart image:** `/timeline?version=N` and its PNG export stay as they were.

## Older finals

A final saved before KAN-86 has no `package`. It is read as **"Legacy package (timeline only) — gap inventory, tactics and priority were not frozen"**, showing only its frozen timeline. Nothing is filled in or inferred for the parts that were never frozen.

## Unknown fields

Readers must ignore fields they do not know. A new field that keeps the meaning of existing ones stays at `iegp-final/1`. Removing or redefining a field means a new `schema_version` (for example `iegp-final/2`), and readers branch on it. Packages are never rewritten in place.
