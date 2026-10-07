# KAN-39 reasoned human revisions

Authority: Jira KAN-39, the KAN-4 parent design, and the user's existing instruction to complete the next tasks. Continue the previously selected subagent execution method without another intermediate approval menu.

## Intent

Agents finish extraction, selection, and linking before human review. Authorized contributors can add a missing gap or tactic, edit a selected item, or remove it. Every action requires a trimmed nonempty reason. Preserve the untouched agent assembly and model evaluation records. A correction creates new immutable item history and an assembly requiring checks and fresh approval.

## Ownership and approach

Extend existing item history, immutable assembly persistence, generation linking, and approval projection. Use explicit human origin records with session subject/provider/actor, action, reason, parent assembly, predecessor version when applicable, source/provenance, and time. Human origin must never pretend to be a generated snapshot or successful extraction output. Existing generated rows retain their current semantics and legacy compatibility.

Revision persistence owns optimistic concurrency and the current revision head. Under the existing workspace lock, accept only a complete current production assembly (pending, approved, or rejected), expected fingerprint, and expected revision head. Reject stale parents and experiment assemblies. Publishing a revision changes the current review target for the covered production batch; the original proposal remains readable but cannot restore live eligibility through its old approval. A new extraction head supersedes its old revisions.

Resolve edits/removals against selected version IDs on the server. Do not accept client-supplied authors, lineage, approval, run IDs, or mappings. An edit retains its canonical claim identity; an addition receives server-generated claim and version IDs. Validate payload structure, source scope, and exact quotes using existing schemas and validators. Human content is not inserted into generated run outputs or benchmark score records. History-only backing claims are allowed, provided approval projection uses exact revised versions and unmanaged readers cannot expose them prematurely.

Save changes and immutable lineage atomically. Do not hold a database transaction open across provider calls. Relink new/edited version pairs using the existing version-bound coverage logic; retain unchanged pair decisions; removing an item removes its links only in the successor. If linking fails, keep a durable incomplete revision that blocks live use and supports retry without duplicating the action or successful calls. Whole-set checks run on the successor. No old approval transfers. Failed or blocked checks remain inspectable.

The current revision head must participate in review-current checks, approved inventory resolution, and publication revalidation. Overlapping production heads must remain fail-closed on incompatible selected versions or evidence. Store revision ancestry and changes explicitly and make fingerprint/recheck behavior consistent for both generated and corrected assemblies. Tenant cleanup must delete dependent revision records before their foreign-key targets.

## API and review interface

Extend the existing workspace-authorized assembly API with a strict revision action and retry. Only authenticated contributors with organization/workspace grants can change content. Identity comes from the session; viewers inspect only. Preserve contributor/Medical Affairs approval roles from KAN-38. Use existing error responses: invalid input 400, signed out 401, forbidden 403, scoped missing 404, stale/conflict 409; log unexpected failures and return a generic 500.

In Complete proposals, show the original agent baseline and human revisions distinctly. Provide labeled gap/tactic add/edit/remove controls, provenance fields, required reason, submission/loading/error/retry states, and keyboard access. Schema-specific fields must be understandable; do not require users to author raw JSON. Refresh to the saved successor and invalidate stale controls after failed refresh. Use existing approval controls for fresh approval of the final checked successor. Removal is a revision action, never deletion of history.

## Proof and limits

Vitest tests prove exact add/edit/remove lineage, required reasons, source validation, authorization, immutable baseline, rollback, competing revisions, incomplete-link recovery, new approval, old-approval refusal, downstream exact payloads and revalidation, extraction supersession, and untouched experiment/model score records. Typecheck and changed-file lint follow focused tests; run the full suite once for final integration. Browser/provider/scale claims require actual evidence. Deterministic checks establish structure and evidence support, not extraction recall or clinical accuracy.
