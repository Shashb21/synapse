# 06: Open gap details with expandable history without losing workspace context

## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

Clicking a gap in relevant Inventory, Prioritisation and Tactics views opens a consistent detail panel over the workspace. Current context and authorised next actions appear first; History is an expandable section, closed by default. Reuse existing full-record content, history and the installed side-panel pattern, establishing the common interaction later used for tactics.

## Acceptance criteria

- [ ] Replace competing selected-gap detail presentations at relevant entry points with a shared panel, full-screen on narrow screens, with **Open full record**. Keep authorised editing routes available and full-record/panel content aligned.
- [ ] Closing returns to the same filters and position and restores keyboard focus to the invoking control. Support keyboard opening, labelled close/expansion controls, focus containment/return and Escape without discarding a dirty edit silently.
- [ ] Show current gap context and next action ahead of a labelled **History** section collapsed by default. History is read-only and newest first; corrections go through authorised editors and append changes.
- [ ] Render recorded event type, affected entity/relationship, actor, time, old/new values, reason and applicable inspectable references. Handle linked-objective events as shared context when supplied; do not present them as statement edits. Reuse the same underlying data as the full record.
- [ ] Use **Reason not recorded** and applicable **Supporting references not recorded for this suggestion** fallbacks for incomplete historical records. Never invent history. Respect existing bounded retrieval and clearly disclose a limit/continuation.
- [ ] Enforce workspace/read permissions for details, history and references on the server. Loading, empty, missing/forbidden and retryable error states do not lose current selection or the underlying workspace.
- [ ] Current priority/context data remains usable through existing records while KAN-120 evolves; render its new fields/events through this common content when available, without duplicating priority calculations or audit stores.
- [ ] Extend browser panel/planning scenarios to cover all relevant gap entry points, expansion, full record, keyboard/focus return, retained filters/position, narrow screens and load-error retry. Focused route tests cover isolation/forbidden history and bounded older records where browser checks are insufficient.

## Blocked by

None (can start immediately using existing full gap records and history).

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect integrated Inventory/readiness work before editing. Extend the current side-panel pattern and full-record/history foundations. KAN-120 owns priority calculations, context edits, support validation and review transitions; consume their readback rather than reimplementing them.
