# Evidence Inventory review

Status: approved design implemented on branch `kan-113-evidence-inventory`, tracked in [KAN-113](https://synapse21.atlassian.net/browse/KAN-113). Verification and review evidence is recorded in `docs/design/kan-113-delivery.md`.

## Goal

Make Evidence Inventory a clear place to review gaps, understand supporting sources and mapped tactics, and resolve outstanding decisions.

## Confirmed decisions

1. Keep the gap table prominent. Manual additions and source suggestions are secondary. Rows remain collapsed by default.
2. Separate Evidence status (Open, Partially Addressed, Addressed) from Review state. Confirmation is human review, not evidence closure.
3. Preserve access to later stages for eligible gaps when new inventory work appears. Show inventory readiness separately from priority progress.
4. Add a Next action column. Expose Confirm status, Resolve partial gap, or Review new source directly; additional outstanding tasks remain in expanded details.
5. Default to All gaps. Add a Needs attention view, independently combinable with evidence-status filtering. Include unconfirmed assessments, partial gaps, new-source review flags, and tactic mappings requiring review. Count distinct gaps; count pending source suggestions separately.
6. Order expanded details: gap statement; sources and supporting statements; mapped tactics and coverage; additional review actions; collapsed Edit gap details. Replace the workbench label “constituent needs” with “Sources and supporting statements”.
7. Replace the large always-expanded source-suggestions panel with a compact summary and explicit inline expansion. Retain links from affected gaps. Use Merge into existing gap, Create separate gap, and Reject suggestion. Explain that merging can return priority to draft and flag mappings for review before final confirmation.

## Findings and classification

- Functional defect: ID sorting compares internal gap IDs despite displaying gap numbers (`src/components/gaps-workbench.tsx`).
- Misleading label: Unconfirmed includes all partial gaps, even ones already human-reviewed (`src/lib/iegp/engine.ts`). Replace this presentation with the agreed separation and Needs attention behavior.
- Misleading readiness: the strip prioritizes previously unlocked Tactics and does not name what its validated count measures (`src/components/plan-chrome.tsx`). Keep access behavior; clarify the two stages.
- Accessibility defect: dynamic reason and settings-save errors lack an explicit announcement region; the reason field is not associated with its error text (`src/components/gap-status-override.tsx`, `src/components/gap-settings-editor.tsx`). Fix included in scope.
- Usability gap: the compact source dialog provides titles and statements but no route to the underlying evidence. The full gap page already provides source context and quotes. A clearly labelled route to that record is included in scope.

These findings come from source inspection and the observed local demo inventory. Sorting and assistive-technology failures have not been reproduced interactively. No exhaustive browser or accessibility audit has been performed.

## Confirmed final scope choices

- Keep evidence verification compact, with a clearly labelled link to the existing full gap/evidence record rather than introducing a new document viewer.
- Include the ID sorting fix and accessible validation/save error feedback in this ticket. Preserve entered values on save failure and existing reasons, confirmation, permissions and audit behavior.
- For multiple outstanding tasks, use a predictable primary-action order: resolve partial gap, review flagged mappings, review new source, confirm status. Indicate additional outstanding tasks on the row and show them all in expanded details; clearing one must not clear unrelated flags. A gap leaves Needs attention only when none of the included tasks remain.
- Keep the current visual identity. Include readable labels, keyboard operation, visible focus, responsive layouts and clear loading/error/empty states; avoid a broader theme or typography redesign.

## Acceptance criteria

- The initial viewport prioritizes the gap inventory rather than an expanded suggestion comparison.
- All gaps remains the default; Needs attention and Evidence status can be combined. Counts distinguish distinct gaps from suggestions and remain clear when filters are active.
- Each row distinguishes evidence status from required human work and exposes its primary action. Confirmed gaps can still require new-source or mapping review.
- Expanded details follow the confirmed order and preserve a route to full evidence.
- Pending source suggestions are discoverable from the summary and affected gaps. Their consequences are visible before acceptance.
- Inventory readiness and Open-gap priority progress are labelled separately. Previously available later stages remain available for eligible work.
- ID ascending/descending ordering follows displayed gap numbers, with a deterministic policy for absent numbers.
- Keyboard users can reach and operate row actions and expanded content. Dynamic errors are announced and associated with relevant fields; failed saves preserve input.
- Existing authorization, required reasons, human confirmation and audit history remain intact.

## Verification plan

Use the repository's Vitest and Playwright suites for focused behavior checks:

- Display-number sorting with deliberately conflicting internal identifiers, both directions and missing numbers.
- All/Needs attention/evidence-status combinations, distinct counts and no-match recovery.
- A confirmed gap with multiple review flags: primary action, remaining tasks and independent flag clearing.
- The already-unlocked plan receiving new unresolved evidence: honest readiness messaging and continued access to eligible downstream work.
- Suggestion expansion and action labels, consequence copy and existing confirmation behavior.
- Required-reason validation and failed settings/status saves: announced feedback and preserved input.
- Browser checks of collapsed rows, expanded detail hierarchy, keyboard focus and narrow-screen layout.

Record the exact commands and results during implementation. This design-only review has not run application tests.

## Boundaries

No changes to scientific coverage definitions, split/merge semantics, prioritization rules, authorization or downstream eligibility rules. No new document viewer, bulk approval, automatic confirmation, or site-wide visual redesign. Preserve unrelated work already present in the workspace.
