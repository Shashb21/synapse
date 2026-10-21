# KAN-121 published implementation tickets

Status: user approved the design, test boundaries and six-ticket breakdown; publication verified.

Specification: https://synapse21.atlassian.net/browse/KAN-140

Source: https://synapse21.atlassian.net/browse/KAN-121

Each ticket delivers a complete workflow, including persistence, public actions, visible behavior and appropriate verification. No separate infrastructure or tests-only ticket is proposed.

1. [Confirm relationship coverage against a human-reviewed requirement basis](01-human-reviewed-requirements.md) — blocked by none.
2. [Show design fit, coverage and unanswered requirements for each tactic](02-relationship-fit-view.md) — blocked by 1.
3. [Preview and link a library tactic with or without assessment](03-library-preview-link.md) — blocked by 1, 2.
4. [Require reassessment after substantive requirement or tactic changes](04-assessment-freshness.md) — blocked by 1.
5. [Link sources and review cited discrepancies without AI](05-manual-source-review.md) — blocked by 4.
6. [Compare every newly parsed document and expose reliable outcomes](06-incoming-document-checks.md) — blocked by 5.

Tickets 2 and 4 can proceed independently after ticket 1. Ticket 3 needs the reusable preview from ticket 2. Document review depends on freshness because accepting a correction must safely invalidate assessments; automatic checks then reuse those complete review outcomes. Both feature areas are required for completion.

All seven created issues have the ready-for-agent label. Native blocking links and saved descriptions were read back and verified. KAN-121 remains unchanged.

## Published issues

- [KAN-141](https://synapse21.atlassian.net/browse/KAN-141): Confirm relationship coverage against a human-reviewed requirement basis
- [KAN-142](https://synapse21.atlassian.net/browse/KAN-142): Show design fit, coverage and unanswered requirements for each tactic
- [KAN-143](https://synapse21.atlassian.net/browse/KAN-143): Preview and link a library tactic with or without assessment
- [KAN-144](https://synapse21.atlassian.net/browse/KAN-144): Require reassessment after substantive requirement or tactic changes
- [KAN-145](https://synapse21.atlassian.net/browse/KAN-145): Link sources and review cited discrepancies without AI
- [KAN-146](https://synapse21.atlassian.net/browse/KAN-146): Compare every newly parsed document and expose reliable outcomes
