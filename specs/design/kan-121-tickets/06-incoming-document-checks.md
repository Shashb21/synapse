# 06: Compare every newly parsed document and expose reliable outcomes

## Parent

https://synapse21.atlassian.net/browse/KAN-121

Specification: https://synapse21.atlassian.net/browse/KAN-140

## What to build

After parsing a document, automatically compare sourced claims with relevant current records in its plan, link support or raise reviewable discrepancies, and show truthful comparison progress and recovery.

## Acceptance criteria

- [ ] Trigger comparison for every newly parsed document when AI is enabled. Reuse Same/Overlapping/New matching and source provenance to find relevant current gaps and tactics within the same plan.
- [ ] Link source-backed supporting claims or create cited possible discrepancies with affected relationships using the same outcomes and human review flow as manual entry. Unknown claims establish neither agreement nor contradiction.
- [ ] Persist Pending, Completed, Failed and Not run because AI is disabled independently of parse status; expose these states with accessible feedback in the document workflow.
- [ ] A parse success never implies successful comparison. A failed check retains the parsed document, its usable content and manual actions; expose an actionable retry.
- [ ] Retry and repeated processing do not duplicate source links, findings or accepted human decisions. Recheck relevant current versions so an older comparison cannot overwrite newer knowledge or falsely declare a changed basis checked.
- [ ] Automatic comparison never confirms coverage, silently replaces confirmed claims or applies substantive corrections. Pending findings preserve verdict/status; accepted changes use the established review flow.
- [ ] Only Completed may show no discrepancies detected, phrased as a check result rather than proof of absence. Failed, Pending and AI-disabled states never show a clean result.
- [ ] Keep manual linking, discrepancy entry and review available when AI is disabled or comparison fails. Preserve existing permissions, audit and approved-snapshot protections.
- [ ] Verify deterministic supporting/conflicting/unknown model responses, unrelated and cross-plan records, all comparison states, parse success with check failure, retry after partial outcomes, repeat processing and version changes through public ingestion workflows; verify visible recovery in a focused browser journey.

## Blocked by

- https://synapse21.atlassian.net/browse/KAN-145
