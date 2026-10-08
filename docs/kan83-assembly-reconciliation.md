# KAN83 and delivered assembly owners

The admin Accuracy ledger uses the delivered item history, complete proposals, contributor revisions, exact reviews and feedback UI. Old `/accuracy/ledger`, `/accuracy/plan` and `/accuracy/experiments` links redirect to the admin surfaces and retain their query parameters.

A managed production workspace consumes the exact current approved selection. Source pages must retain successful run identities and cover the full source before an extraction assembly can authorize downstream use. The projection retains structured facts, explicit unknown reasons and actual tactic lifecycle. Approval records current human factual and pair decisions bound to the selected versions, fingerprint, reviewer and rationale; pending pairs remain unvalidated. Persisted factual drift invalidates live consumption.

Manual coverage, confirmed split and inverse changes use the existing immutable revision owner. They require no provider. A cross-source change retains all current selected heads, retains unchanged version-bound coverage, and represents other unassessed pairs explicitly as pending. Revision pointers move together in the workspace transaction. The complete successor needs its own exact approval; confirming a split creates an awaiting-approval operation, not a live split. Approval atomically materializes the exact children and retires the parent. An inverse creates another successor and needs another approval. Original reviews, versions and operation snapshots remain available. Later human decisions or descendants block inverse preparation. Legacy unmanaged split and exact inverse behavior remains immediate and atomic.

Customer S8, Accuracy and isolated retained benchmarks call the same S8 scoring owner. Benchmarks bind the default axis catalog and `s8-default-quadrants-v2`, including Defer. Retained benchmark split materialization is experiment-only; it cannot perform live human split application.

## Isolated baseline history

The existing experiment record's `baseline_snapshot.managed_history` retains a typed, remapped audit archive of selected item versions, assemblies/items, reviews, revisions/heads/attempts, relationships, feedback, extraction runs/events/batches, human pair decisions and original claim/coverage/split/priority decisions. It has `authority: audit_only`. No copied item-version, assembly or review rows are manufactured. `baseline_origin` retains the source audit lineage; literal prose and historical fingerprints/revision tokens are preserved.

Copying strips assembly authorization references from active claim and pair metadata and leaves managed factual/pair/priority validation stale or unvalidated. Legitimate legacy validation still uses the existing current-only identity rebasing; stale tokens are never refreshed. Managed split operations are explicitly archived and read-only in the target; their source-approved inverse cannot restore a parent or overwrite later target human edits. Ordinary legacy split inverse guards remain unchanged.

`copyExperimentWorkspace` returns the baseline to the existing `createExperiment` owner, as its operational callers already do. Re-copy reads that persisted baseline and unions any newly produced local history before remapping the complete selected graph again. An unpersisted copy cannot silently discard its archive: re-copy refuses until its experiment baseline is retained. Unknown/external typed references and incomplete selected graphs fail atomically. Paired comparisons normalize the copied operation retry identities back to their original audit identities when checking matched setup.

Verification uses scripted providers and synthetic fixtures. It makes no clinical accuracy claim.
