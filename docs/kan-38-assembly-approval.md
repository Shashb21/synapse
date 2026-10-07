# Assembly approval (KAN-38)

Open **Accuracy -> Ledger**, choose a workspace, and expand **Complete proposals**. List entries use a neutral **Complete proposal** label; inspect one to see its current review status. The review form is shown only after the full immutable proposal detail and review metadata load from the server.

The detail view shows the exact proposal fingerprint, live-head status, review status, deterministic findings, source scope, selected items, mappings and coverage. Approved and rejected decisions show the immutable reviewer, review time, rationale and advisory reasons. A rejected proposal pauses live use until a revised complete proposal is generated and approved.

Reviewers with contributor or Medical Affairs access can approve or reject a current pending proposal. Both decisions require a nonblank rationale. Every advisory finding requires an explicit acknowledgement and reason. Blocking deterministic findings disable approval, but rejection remains available so the reviewer can stop use of the proposal.

The UI sends the displayed fingerprint and the current expected review identity with every decision. Only one decision can be submitted across the panel at a time. After the server accepts a decision, the proposal list and detail are reloaded from the API. The old review form is hidden during detail refresh; if that request fails, **Retry proposal** loads a fresh detail before any further decision. If another reviewer decides first, the UI keeps the local proposal pending, shows the conflict, and asks the reviewer to refresh.

Verification:

```bash
npm test -- tests/accuracy-assembly-review-ui.test.ts
npm test -- tests/accuracy-assembly-ui.test.ts tests/accuracy-assembly-review-ui.test.ts
npm test
npm run typecheck
eslint src/components/accuracy/assembly-history.tsx tests/accuracy-assembly-review-ui.test.ts
git diff --check
```

## Production consumer inputs and workflow options

The kernel checks managed production input against the current approved projection before opening a run. Unknown members, substituted content, changed relationships, and incomplete evidence are conflicts. Internal preparation and isolated experiment scopes remain exempt. Legacy compatibility lasts only while there is no applied production extraction batch; a run cannot publish a legacy result after the workspace becomes managed, even if the new assembly is approved.

- **Gantt:** supply the complete approved tactic membership and matching validation. Omitted tactic type, dependency links, gap links, gap hierarchy, and coverage are resolved from the approved projection. If supplied, those fields must match it; supplied gaps and coverage must be complete. Explicit `start`, `end`, and `readout` dates on tactics or activity overrides are scheduling options. Activity overrides must reference approved tactics; optional activity IDs must be canonical `ACT-<tactic_id>`, and supplied dependencies must match approved links. Scheduling does not change approved content or coverage.
- **Ideation:** callers may select approved gaps, set `hints`, and choose `per_gap` (1–3). Gap statements, status, priority and validation must match the approved projection with its allowed workflow overlays. Omitted validation is resolved from that projection. `existing_tactic_names` must include the complete approved library, with no substitutions or omissions.
- **Status:** `gap_ids` selects which gaps to compute (omitted or empty retains the existing all-gaps behavior), and `persist: false` requests computation only. Omitted tactic/coverage arrays use approved evidence. Supplied arrays must contain the complete approved tactic lifecycle and coverage sets, including residual partial/limited evidence, even when selecting fewer gaps. Row order and supported coverage aliases do not affect equality. The direct status module uses the same validator and reads the full managed inventory without a list cap.

Public claim insertion, metadata, patch and validation helpers hold the shared workspace transaction lock from their approval gate through their durable write. Mechanical production execution, including legacy execution, holds that lock through final publication; a failure rolls back its business writes. Agentic calls recheck their exact managed binding or continued legacy state inside the final publication transaction. Omission gates remain independent.
