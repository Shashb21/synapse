# Gap and tactic details with expandable history

Design agreed during the [KAN-120 interview](kan-120-prioritisation-review.md), with the shared interface owned by [KAN-124](https://synapse21.atlassian.net/browse/KAN-124). The owner confirmed the consolidated design on 16 October 2026; both Jira issues now contain the agreed scope, verified by readback. No application implementation performed.

The [full specification](kan-124-spec.md) is published on the existing issue with ready-for-agent, retaining Calix Tan as assignee and To Do status. The [implementation-ticket proposal](kan-120-124-tickets/README.md) is prepared for approval before child-ticket publication.

## Interaction

Clicking a gap or tactic opens its details in a side panel while preserving the current planning context. Use a full-screen presentation on narrow screens. Offer Open full record for deeper work. Closing restores the previous filters, position and keyboard focus. Keep existing editing responsibilities and permissions: objective/decision/dates in Setup, gap data in its editor, and priority judgement in Prioritisation.

History is a labelled expandable section inside the detail panel, collapsed by default. It is not another floating window. Use the same detail/history pattern from relevant entry points in Inventory, Prioritisation and Tactics, with the relevant current details and next action visible before History is expanded.

## History contents

Show newest first. Each recorded change identifies the event, affected record/relationship, person or automated actor, timestamp, previous/new values where recorded, reason and supporting references where applicable.

- Gap: statement, objective assignment, priority/confirmation, tactic links and coverage assessments. Include objective-context changes that caused its priority to need review.
- Tactic: tactic fields, lifecycle, linked-gap relationships and related coverage/decision changes. Identify the counterpart gap so one tactic reused across gaps remains understandable.
- Relationship changes: render the same underlying event from each affected record. Do not duplicate the underlying decision records or tactic entities.
- Preserve discoverability of accepted/rejected/current tactic decisions and previous/planned work as gaps leave Open, consistent with KAN-124's original scope. Do not broaden active AI ideation eligibility.

Every new saved change covered by these flows needs a reason and an audit record. Manual date edits do not require supporting references. LLM-generated judgements require inspectable supporting references. Mark unavailable historical information explicitly, including Reason not recorded and Supporting references not recorded for this suggestion; never fabricate history.

## Integrity and access

Reuse existing responsible data stores and history records. The view is read-only; correcting a record goes through its authorised editor and creates a new change entry. Preserve workspace/access restrictions when returning history and linked evidence. Loading/empty/error states must explain what is available and allow retry without losing the selected record or the underlying workspace context.

## Existing foundations

The current branch already has full record pages at `src/app/gaps/[id]/page.tsx` and `src/app/tactics/[id]/page.tsx`, both using `src/components/entity-history.tsx`. Their History lists are always visible today. Reuse their record content and authorised actions for the panel and Open full record route rather than maintaining competing detail implementations.

Tactic Ideation already has an editable side panel at `src/components/tactic-ideation/tactic-panel.tsx`, built on the installed Sheet component, with coverage in `e2e/features/kan-50-tactic-side-panel.spec.ts`. Extend or consolidate that existing presentation and retain its authorised editing and reason validation when introducing the common gap/tactic detail experience.

`src/lib/iegp/entity-history.ts` combines existing edit records and audit actions, folds duplicate action/edit entries from the same request, sorts newest first and limits results to 200. It already exposes actor, time, reason and recorded old/new values, but has no structured supporting-reference field. The agreed reference and shared-objective history behavior therefore needs additions in the responsible history/data layer; a panel alone cannot supply missing audit data. Keep long histories bounded and make any limit or continuation clear. Missing historical reasons currently appear as “No rationale given.”; the agreed display wording is “Reason not recorded.”

Keep current coverage semantics, human decisions and original records intact. A gap becoming Partial/Addressed or changing priority must not orphan its previous tactic decisions. Long histories must remain usable without loading an unbounded number of events at once.

## Ownership and verification

KAN-120 supplies priority context, supported suggestions and audited priority-review transitions. KAN-124 owns shared detail/history presentation, related navigation and existing downstream discoverability work. Coordinate their shared history requirements without creating parallel audit stores.

Verify a gap through confirmed High → accepted tactic → planned tactic → Partial, with history reachable throughout; one tactic used by multiple gaps; a shared-objective deadline changing priorities across hidden setting views; manual/AI history and incomplete older history; restricted access and load failures; keyboard focus/escape/expansion, preserved workspace context and narrow-screen operation.
