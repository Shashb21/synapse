# KAN-39 Task 2 fresh frontend review

## Verdicts

**Specification compliance: changes required.** The implementation meets the reasoned contributor forms, immutable-history presentation, strict request bodies, independent server permission flags, incomplete-link retry, and stale-control invalidation requirements inspected here. F1 prevents the required current-successor navigation after a concurrent contributor change.

**Code quality: changes required.** One Important, concrete rendering/navigation defect is established. No Critical findings or other established Important findings. The component separation and explicit shared submission guard are appropriate for the requested scope; this review does not recommend a broad redesign.

## F1 — Important: current successor outside the cached list never renders

**Locations:** `src/components/accuracy/assembly-history.tsx:801`–804 (`navigateDetail`); rendering dependency at 845–863; entry points at 468 and 471. `loadDetail` stores only `details[assemblyId]` at 675 onward and does not add the returned assembly to `list.assemblies`.

**Concrete trigger:**

1. Contributor A loads Complete proposals when its list contains baseline B and no successor S.
2. Contributor B publishes S. A's next revision of B receives a conflict, disabling its controls as intended.
3. A chooses Refresh proposal. The fresh B detail is stale, with `revision_state.current_head_id = S`, and displays Inspect current successor.
4. A chooses Inspect current successor. `navigateDetail(S)` changes the open ID to S and successfully fetches S's fresh detail.
5. S remains absent from `list.assemblies`. The renderer maps only that cached list, so no row matches the new open ID. B closes, S's detail is never rendered, and the user sees neither S's inspection/approval/retry controls nor its loading/error/retry state. Closing and reopening Complete proposals also does not reload a nonnull list (806–809).

The same issue occurs when an older revision's current-head pointer advances between list and detail reads. It does not require a malformed response or a paginated backend. The established normal path—this panel saving a revision itself—adds the successor to the list before navigation (781–785), but the explicit history-navigation path omits that step.

**Why this matters:** The conflict recovery guide instructs contributors to refresh and inspect the current successor. This sequence strands the panel on the older list, blocking inspection, fresh approval, and recovery of an incomplete successor until a full panel/page reset. Server-side concurrency protections still prevent an unauthorized or stale mutation; this is a frontend workflow failure.

**Minimum correction:** Make any successfully fetched navigation target renderable independently of the list snapshot, or merge the authorized fetched assembly and its revision state into the cached list. Keep the exact requested successor ID, restore mutation/review permissions only from its successful fresh detail, and expose navigation loading/errors even when the target was absent from the original list. Avoid depending solely on a list refresh that could fail after a valid detail read.

**Minimum behavioral regression:** Arrange an initial list containing only B; B detail supplies a stale revision state pointing to unseen S (or reach that state through conflict + refresh). Click Inspect current successor and return a successful S detail. Assert that S's fingerprint/content and appropriate server-authorized controls are visible, B's old approval controls are absent, and baseline navigation still works. Also cover a failed unseen-target detail response: the error and retry action must be visible and no mutation/review controls enabled. The existing navigation test arranges `[successor, baseline]` before clicking, which cannot exercise this defect.

## Reviewed guarantees

- Add/edit/remove uses labeled substantive fields, required trimmed reason, authorized source/block choices and source text; no raw JSON authoring.
- Current strict gap/tactic schemas match submitted payloads. Edits preserve all existing spans and their untouched offsets, external ID, tactic type/status/question; generated payload ID and server identity/lineage/mappings are omitted. Remove sends only selected version and reason. Changed quote/block drops that span's obsolete offsets.
- Human origin, baseline/revision and linking status labels use server metadata. Existing agent history stays inspectable.
- `can_revise`, `can_retry_revision`, and `can_review` are independent detail flags. Viewer and Medical Affairs permissions are not inferred from revision metadata.
- Retry sends the saved incomplete assembly, its fingerprint and current head. Revision/review POSTs share a synchronous ref guard; UI fields/actions disable while it is held.
- Failed/conflicting mutations and failed list/detail refreshes invalidate cached authority and pending detail requests. Successful detail is the authority-restoration boundary. Workspace keys and unmount/token checks discard old workspace responses.
- Native form labels, selects, inputs and buttons provide semantic keyboard primitives; revision/detail/list loading uses status messages and failures use alerts. Browser layout and complete assistive-technology behavior are not established by this source review.

## Evidence and scope

Read-only review of the Task 2 diff/new files against accepted `eba5f92`, Task 2 report, plan, design specification, review focus, exact accepted backend contract, current payload schemas, API flags, and relevant history/form/UI tests. No source edits, git writes, subagents, or unchanged test reruns. The only file written is this report.

Worker verification evidence retained: focused five-suite unchanged rerun passed 51 tests, typecheck passed, changed-file lint passed, diff whitespace check passed. The prior combined run timed out once in the authorization test with anomalous reported 976117 ms elapsed; its cause remains unknown. Passing fixtures do not disprove F1 because they always place the navigation successor in the list before following the pointer. Full-suite integration and actual browser/provider/scale behavior remain controller-owned verification.
