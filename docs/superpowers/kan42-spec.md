# KAN-42 design proposal — approved

## Intent and authority

Jira KAN-42 is To Do under KAN-4; KAN-38 and KAN-41 are confirmed Done.
Capture contributor observations about the exact approved production output that was used, retain selected item/source/run traceability, and never present those observations as gold precision, recall, or F1.

Checkout: /private/tmp/synapse-kan40-workspace, clean at published KAN-41 commit 9d0635b. Preserve the unrelated personal-projects checkout. Keep KAN-4 open.

## Recommended approach

Extend the existing immutable assembly detail and use recorded historical approval bindings. Production consumers already persist `assembly:approved-live-bindings` in their run steps. Validate that retained record rather than infer consumption from the current live head or invent another execution log.

An append-only PostgreSQL feedback record binds workspace, assembly ID/fingerprint, approval review ID, successful production consumer run, optional selected item version IDs, a categorized observation, required rationale, authenticated contributor identity, and creation time. Whole-assembly feedback permits an empty item subset. Resolve evidence from the exact selected versions. Retain the assembly's extraction and coverage lineage independently from its consuming run.

Observation categories cover accepted unchanged, edited, rejected, missing item, split/merge, and override. These describe human observations; they do not change content, approval, production run evaluations, or benchmark scores. Content changes continue through the existing reasoned-revision workflow.

Derive actor identity from the signed-in session. Contributor writes follow authorized workspace access; other authorized readers inspect history. Strict request validation rejects forged actor, workspace/run/version mismatch, unapproved/rejected assembly, experiment run, failed run, and a run whose recorded binding does not identify this exact approved assembly.

Permit retrospective feedback after an assembly is superseded when its historical approval and successful consumption binding are provable. Read and write by exact immutable assembly identity, never by its moving successor head. New assemblies start with their own feedback history.

Show production feedback alongside approval/reviewer actions, source-linked checks, and selected item provenance in Complete proposals. Select only server-verified consuming runs; show run identity/time. Submission must protect against duplicate clicks, stale detail, failed refresh, and workspace-switch responses. Explain that feedback is an operational observation without gold-standard accuracy metrics.

## Alternatives considered

1. Attach feedback only to extraction runs: smaller, but an extraction run precedes approval and does not prove use of the approved output.
2. Reuse exact historical consumer bindings (recommended): proves use and preserves historical truth with one feedback table and the existing panel.
3. Add a separate usage-tracking subsystem: duplicates recorded binding evidence and broadens scope unnecessarily.

## Planned ownership and proof

1. Domain, additive schema, transaction-protected store, workspace cleanup, and real PostgreSQL tests. Prove happy path, historical supersession, item/evidence/run binding, forbidden/mismatched records, and validation rollback.
2. Authenticated API and tests. Prove signed-out/role/tenant isolation, strict payloads and server identity, exact feedback reads, and invalid run/version rejection.
3. Existing-panel UI, usage guide, and behavioral UI tests. Prove form submission/history, permissions, no gold labels, separate successor history, refresh failure, submission serialization, and late-response handling.

Use the repository's TypeScript/Vitest suite, typecheck, scoped ESLint, and diff checks. Tests follow Arrange / Act / Assert: prepare saved evidence, perform a user/store/API action, then check the resulting behavior. No paid model calls are necessary. Subagents implement sequentially, each task receives independent spec/quality review, then the branch receives a whole-change review.

## Evidence and limitations

Fresh baseline: `npx vitest run tests/accuracy-assembly-review.test.ts tests/accuracy-assembly-review-ui.test.ts --silent` passed 12/12 in two files (exit 0).

No KAN-42 product code has been changed, and that baseline does not verify the proposed feedback feature. Production records lacking provable historical consumption cannot be offered as consumed output; do not silently backfill them. Human acceptance is not evidence of clinical correctness.

Design approved by the user on 2026-10-06. Execute the saved implementation plan using the requested subagent-driven development method.

## Consumption scope refinement
An assembly binding proves consumption only for the projected source/kind items. Reconstruct exact consumed versions from the complete historical binding set using approvedLiveInventory rules. Empty feedback selection means all consumed items from this assembly. Never infer full-assembly consumption from a partial binding.
