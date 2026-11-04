# UI-9 and UI-10 Development clarity implementation plan

Goal: Reduce reading effort and bring the selected experiment workflow higher on the page.
Spec: Jira UI-9 and UI-10, subtasks of UI-1. PR target updated-dev-environment-ui; leave open.
Base: 32894db (includes independently reviewed UI-7/UI-8 presentation work, not yet in target).

## Global Constraints

- Work only in /private/tmp/synapse-ui1-review on feat/ui-9-10-development-clarity. Preserve unrelated edits; only controller commits/publishes.
- Preserve palette, font, UI-7/UI-8 hierarchy/spacing, semantic headings, keyboard accessibility, wrapping and all saved evidence.
- No backend/API/execution/evaluation behavior changes. Preserve all busy/error/success feedback, actionable disabled reasons, fixed-copy/privacy meaning, charges/unknown charges, provisional AI vs human approval, uncertain retries, stale recovery and partial success.
- Use native details/summary for optional evidence; keep stateful forms mounted when closed so useful values/errors survive. Hide forms only after moving focus safely. Busy forms cannot be closed while an action is pending. No new UI framework or speculative abstraction.
- Read installed Next.js guides and impeccable craft-floor before frontend edits. No PRODUCT.md or DESIGN.md is present; preserve incumbent UI.
- Verification: npx tsc --noEmit, scoped ESLint, existing targeted Vitest and browser interaction tests using isolated temporary server/database. No provider charges.

## Review Focus

Dirty rename must continue blocking experiment switching and creation; cancel explicitly discards the name and restores focus. Stale reload retains edits.
Disclosure closure must preserve creation/report values and errors; successful create/rename must restore sensible focus.
Unknown charges, pause/resume and override consequences must remain visible; report totals remain unverified and uncertain sends stay restricted.
Comparison must keep section/pair blockers and missing evidence even when overall outcome is shown once.
Idle status suppression must leave useful accessible busy, blocked, error and success feedback and valid description references.

### Task 1: UI-9 shorten guidance and suppress routine status noise

Own src/app/admin/development/page.tsx, copy/status presentation in src/components/development/*.tsx and focused tests. Do not implement UI-10 disclosure changes yet.
- Use exact lead: Test generation with private documents, then review and compare saved results.
- Evaluation lead: Assess a saved output without generating it again. Factual checks, reference comparisons and provisional AI scores appear separately. Evaluation may incur provider charges. Define profile next to selector and expected-answer references beside controls.
- Demo guidance: Add private, fixed copies of the Velmara demo files. AI parsing may incur charges. Enable ingestion in Admin controls before adding files. Link Admin controls to /admin/control.
- Suppress routine available/ready/no-change prose across setup, execution, evaluation, history, comparison and spending; preserve meaningful busy/blocked status and valid aria-describedby targets.
- Backup providers: inspect src/modules/development/routes.ts. It resolves primary then saved fallback array, on unavailable credentials, not request errors. Use readable provider labels and actual saved order; explain checkbox selection order accurately without changing routing.
- Shorten generation/matching explanations at point of use while preserving material distinctions listed above.
- Write meaningful behavioral coverage for conditionally hidden status (idle versus blocked/busy/error). Run existing readiness/demo/documents/results tests plus new tests, scoped lint and typecheck. Report all commands/results and deferred requirements.

### Task 2: UI-10 disclose management forms and technical evidence

Own src/components/development/development-setup.tsx, development-evaluation.tsx, development-results.tsx, development-comparison.tsx, development-costs.tsx and relevant tests. Consume Task 1 copy/status changes; preserve them.
- Compact New experiment action opens form; show form directly when no experiments. Keep selection findable. Rename beside selected title reveals name/save/cancel. Keep reload available for stale recovery outside rename if needed. Preserve useful values/errors when closed and restore focus safely. Dirty rename lock and stale recovery are invariants.
- Output review state and retained status stay visible; execution/attempt IDs and SHA-256 move under Saved output details.
- Collapse result records by default with descriptive summaries; retain every original field when opened.
- Show overall comparison outcome once and only populated diagnostics at section/pair level. Keep actual blockers/missing evidence and One trial cannot establish statistical superiority. Pair IDs under accessible details.
- Keep spending pause state/action, allowance, known generation/evaluation usage, unknown-charge warning, override effects and uncertain-send restrictions visible. Reservations and estimate breakdown under Spending details; owner report form under Report provider total. Preserve estimates/measured/unverified-report meaning and form values/errors.
- Test creation/rename focus, cancel, unsaved guards, stale reload, retained form errors/values, evidence disclosures, populated comparison diagnostics and costs. Existing browser tests must be updated for intentional disclosures rather than weakening assertions. Run smallest sufficient tests, scoped lint/typecheck and browser checks. Report changed files, command/results, limitations.
