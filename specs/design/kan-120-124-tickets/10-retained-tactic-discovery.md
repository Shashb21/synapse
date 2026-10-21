# 10: Keep tactic options and planned work discoverable as gaps progress

## Parent

[KAN-124](https://synapse21.atlassian.net/browse/KAN-124)

## What to build

From a gap, a planner can find accepted, rejected and current tactic options and planned work even after its evidence status or priority changes. Use the common gap/tactic detail navigation and existing records to make the next step clear while preserving current eligibility and previously unlocked access.

## Acceptance criteria

- [ ] A confirmed High/Open gap can progress through accepted proposed tactic → planned tactic → Partially Addressed, with the tactic, rationale, rejected/current alternatives and decision history still discoverable from the gap.
- [ ] Retain routes to prior/planned work when a gap becomes Partially Addressed or Addressed, changes priority or needs priority review. Do not orphan or duplicate tactic/option/decision records when active eligibility changes.
- [ ] Use the shared gap/tactic panel and full-record fallback for record inspection, retaining filters/position/focus. Clearly distinguish current eligible ideation from existing options and planned work.
- [ ] Explain the manual/library route for Medium/Low gaps. New AI ideation remains restricted to confirmed High/Open gaps, including renewed confirmation after changed context when that state is available.
- [ ] Preserve initial readiness/unlocking rules and retained access from integrated KAN-113/KAN-118 work. New unresolved Inventory work does not remove otherwise eligible downstream access. Reuse existing logic; do not recreate it.
- [ ] A tactic reused across gaps remains one tactic with separate relationships. Preserve current coverage meanings, option-generation logic and permissions.
- [ ] Give accessible empty/loading/error/retry states and useful permitted routes if a record is unavailable. Server reads obey workspace boundaries; failed navigation does not lose the underlying workspace.
- [ ] Extend existing browser planning/ideation journeys to prove High → accepted → planned → Partial, changed priorities, Medium/Low manual routes, retained access after new Inventory work, and reuse without duplicate tactics. Use persisted readback and deterministic model fixtures; add focused route checks only where access cannot be proved through the browser.

## Blocked by

- **07: Unify tactic details and editing with the shared history panel** — completes both record-panel targets used by this discovery/navigation journey; ticket 06 is a transitive prerequisite. Existing decision records and eligibility mechanisms are reused rather than waiting for new audit coverage.

## Implementation context

Repository: https://github.com/Shashb21/synapse. Re-fetch the parent and inspect integrated access changes first. This delivers original KAN-124 discoverability scope alongside the approved panel design. Do not take over KAN-121 fit, KAN-122 option-generation, KAN-123 progress metrics, KAN-125 ingestion clearing, or KAN-84 approval/workshops.
