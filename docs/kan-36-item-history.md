# Generated item history (KAN-36)

Open **Accuracy → Ledger**, select a workspace, and expand **Item history** on a gap or tactic. History loads on demand. Each version shows its original claim ID, source file, run, snapshot, iteration, original array index and recorded time. Payload fields show the exact stored content, including generated IDs and provenance; **Exact stored payload** exposes the complete JSON. A judged final output may have no snapshot or iteration. Older claims without captured history explicitly show no recorded versions; no historical origins are invented.

History-only alternatives are labeled **Draft for review** and have no Validate action. Review visibility does not grant downstream eligibility. Inspecting versions, confirming identity and recording ancestry do not select an alternative or approve its content. To verify exclusion, run `npm test -- tests/accuracy-item-history-eligibility.test.ts tests/accuracy-gantt-continuity.test.ts`; these cover ordinary and explicit-ID consumers, including Gantt references.

## Reviewing uncertain identity

**Identity and ancestry** lists same-item, split and merge relationships, predecessor/successor IDs, the proposal reason, and the recorded contributor and decision reason. Contributors can enter a reason of at least three characters and choose **Confirm identity** or **Reject relationship** for pending proposals. The server supplies the authenticated actor and validates workspace access. Viewers see history and decisions without write controls. A successful decision refreshes history and the ledger. Failures are announced and preserve the reason for retry.

A stale pending proposal means versions changed since it was proposed. Review the latest content, enter a new reason, and choose **Propose fresh relationship**. This submits the same kind and original predecessor/successor IDs; the server captures the current version basis. It preserves the previous stale proposal in the audit trail. Confirmed and rejected records remain visible.

Automatic matching is conservative: only a unique exact same-type, same-workspace, source-backed payload match can join an identity automatically. Generated top-level IDs are ignored for that comparison. Similar words, reused external IDs, array position and shared source blocks alone cannot prove identity. Different questions can use the same quote. A confirmed same-item link unifies history while preserving immutable version ownership; it does not promote a history-only draft.

## Explicit ancestry

Splits and merges retain distinct entries. The contributor endpoint supports an explicit proposal:

```json
{
  "workspace_id": "your-workspace-id",
  "action": "propose",
  "kind": "split",
  "predecessor_ids": ["original-claim-id"],
  "successor_ids": ["first-draft-id", "second-draft-id"],
  "rationale": "This generated question now covers two distinct needs."
}
```

POST the request to `/api/accuracy/claims/relationships` from an authenticated contributor session. A split requires one predecessor and at least two successors; a merge requires at least two predecessors and one successor. Successors must be stored history-only generated entries. The server checks stored versions and rejects incompatible or stale decisions atomically. The ledger displays the resulting proposal for review. This ticket provides review of existing proposals and stale recovery; it does not add a general-purpose ancestry creation form.

KAN-37 owns assembling content from mixed alternatives. KAN-38 owns approval of those exact assemblies. KAN-39 owns later human content edits. Gold reference answers remain evaluator-only.
