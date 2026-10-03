# KAN-38: Approval of exact live assemblies

## Intent and authority

Jira KAN-38 requires authenticated contributor or Medical Affairs approval/rejection of the complete checked extraction proposal before live downstream consumption. Reviewer identity, decision, time, rationale, exact assembly identity, and advisory override reasons are retained. Blocking deterministic failures cannot be overridden; rejection pauses with no fallback. The user requested continuous subagent implementation, with human review at the end and reason-required later additions/removals (KAN-39).

## Design

Extend KAN-37 immutable assemblies with append-only review decisions. Bind decisions to the assembly ID, content fingerprint and exact check report. Approval rechecks the persisted body against workspace evidence; reject mismatched fingerprint/output, blocking findings, incomplete linking, and stale production batch heads. A nonblank rationale is required for both decisions. Every advisory finding must be explicitly acknowledged with a nonblank reason. Authenticated session identity and role are authoritative; viewers and operators cannot review under this ticket's explicit allowed-role list.

Production live inventory is resolved from approved immutable proposals, not whatever generated claim rows happen to contain. For each source and extraction kind, use the current applied production batch (not the most recent approved batch). A one-kind extraction retains the other kind's current head. An applied batch with missing/incomplete/unapproved/rejected assembly pauses; no previous proposal substitution. Assemblies generated from experiment runs never qualify as production heads. Legacy workspaces without applied production batches retain their existing claim workflow. Experiments and automatic extraction preparation run under a trusted internal asynchronous scope; HTTP bodies cannot request that scope.

Project the selected exact item payloads onto canonical claim identities for existing downstream modules. Preserve only documented workflow overlays that do not replace selected extraction content (priority, validation, derived status and scheduling fields absent from the selected payload). Assembly approval counts as validation of its selected items. Selected statements/names, evidence, lifecycle fields present in payload, source and membership always come from the immutable proposal. Map stored version-bound coverage to the selected canonical IDs. Exclude unselcted rows and never infer alternate links; if heads conflict in selected identity or evidence, pause instead of guessing.

The same approved inventory boundary must protect list readers, explicit ID reads for live consumers, and caller-supplied payloads to production modules. Post-extraction module execution records consumed assembly/review identities. Approval/publication and downstream durable writes use the existing workspace transaction lock; long provider calls need not hold a database lock, but must revalidate the consumed head set before publishing output/effects, rolling back if the head changed. Generation coverage is a trusted internal exception with exact selected version inputs; ordinary coverage calls require approved inputs. Omission pause rules remain independent.

Existing human coverage/content mutation routes cannot silently replace an approved assembly. Route operations may update workflow fields where explicitly supported; content or link edits remain blocked with an actionable reason until KAN-39 can create a revised checked proposal. UI permits review only after complete proposal inspection, shows current/stale/pending/approved/rejected status and reviewer evidence, and handles errors and competing reviews.

## Verification

Vitest is the repository's TypeScript test framework. Tests use Arrange (prepare records), Act (review or consume), Assert (check output or refusal). Test role/tenant authentication, rationale and advisory acknowledgements, immutable body and report binding, stale heads/rejection without fallback, per-kind head retention, absent assemblies, exact selected earlier versions, experiment isolation, explicit input bypasses, concurrent review/publication, automatic linking before approval, and accessible UI errors/state refresh. Run focused tests per change; full suite, typecheck, changed-file lint and diff whitespace checks once for final integration.

## Scope and tradeoffs

No KAN-39 human item editor, no gold-based accuracy claim, no unrelated authentication overhaul. Canonical live projection reuses existing claim-shaped consumers instead of introducing a second planning engine. Legacy compatibility applies only before a workspace has applied production extraction batches; generated managed workspaces fail closed.
