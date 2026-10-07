# KAN-39: reasoned human revisions

Complete proposals in the Ledger now supports contributor additions, edits, and removals after agent extraction and linking. Each change saves a new proposal, called a **successor**, instead of overwriting the original. The original agent proposal, its generated item versions, and evaluator gold/model scores remain readable and unchanged.

**Provenance** means the source file, evidence block, and quoted text supporting an item. A **revision head** is the current saved proposal for a production batch. A **fingerprint** identifies the exact content and checks being reviewed. These values let the server reject an action based on an outdated proposal rather than overwrite another contributor's work.

## Contributor workflow

1. Open **Complete proposals** and inspect the current proposal. **Agent baseline** identifies the original agent result. **Human revision** identifies a contributor change, with linking complete, incomplete, or failed shown separately.
2. Choose **Add gap**, **Add tactic**, or the selected item's **Edit**/**Remove** button. These controls appear only when the server permits contributor changes to that proposal. Viewers inspect history; Medical Affairs can review when authorized but cannot change content unless their authenticated role is contributor.
3. Enter a **Reason for change**. Every add, edit, and removal requires a nonblank reason. Gap fields are statement and optional external ID. Tactic fields are name, tactic type, tactic status, and evidence question. Tactic content retains its inventory classification; its authorship is separately recorded as human.
4. For additions and edits, choose an authorized source and evidence block, then copy the supporting quote from the displayed source text. Block options include source-text excerpts and their IDs. Add further evidence quotes when needed. An edit keeps its original source and every existing evidence span, including character positions. Changing a quote or block clears that span's previous positions; other spans remain unchanged. Removing an evidence quote is explicit. At least one valid quote must remain.
5. Choose **Save revision**. The server obtains the author from the signed-in session, validates the whole change, saves immutable history, and links the changed item versions. The UI opens the exact saved successor and reloads its detail before enabling further decisions.
6. Inspect the successor's whole-set checks and coverage. A change requires fresh approval of that successor. The baseline's old approval does not transfer. Reviewers enter a rationale and acknowledge any advisories using the existing KAN-38 controls. Blocking findings prevent approval.

Removal only removes the selected item and its links from the successor. It does not delete the original claim, generated output, item version, or proposal history. Its source and evidence are resolved from the selected stored version by the server.

Use **Inspect agent baseline** to compare the successor with its original proposal. A historical entry whose head has moved offers **Inspect current successor**. Human item lineage shows the contributor, reason, revision, parent, and predecessor; it does not invent an extraction run or snapshot.

## Failed linking and conflicts

A provider failure can still return a successful durable save. The saved successor is labeled **Linking failed**, shows the provider error, and remains blocked from live use. If the server authorizes it, choose **Retry revision linking**. Retry uses the failed successor's fingerprint and head, reuses successful coverage calls, and opens the newly saved completion successor. It does not duplicate the original contributor action.

A competing revision, new extraction, or incompatible production scope can make the displayed parent stale. On a conflict or failed refresh, mutation and review controls are disabled until a successful detail refresh. The old content remains inspectable where available. Use **Refresh proposal** or **Retry proposal**, then inspect the current successor before deciding. A failed save must be refreshed before trying again; the server may already have durable history if the network response was lost.

Revision and approval submissions share one in-flight guard, meaning only one can be submitted at a time in this panel. Buttons and form fields are disabled during submission. Loading is announced with a status message and errors with an alert. Switching workspaces discards the prior panel's state and ignores late responses.

## API and authorization

The UI calls `/api/accuracy/assemblies` for list/detail reads, revisions, retries, and reviews. Detail returns authorized `evidence_blocks`, `revision_state`, and the independent `can_revise`, `can_retry_revision`, and `can_review` permissions. The UI never derives these permissions from actor labels or `revision_state.can_retry`.

Revision requests contain workspace, parent, expected fingerprint/head, and one reasoned change. Edit/remove identify a selected item version. Add/edit send schema-specific content and provenance without generated payload IDs. Actor identity, human origin, lineage, approval, extraction run IDs, mappings, and successor IDs remain server-owned. Retry requests identify the exact saved incomplete assembly and its expected fingerprint/head.

Source content must belong to the original production lineage. An opposite-kind addition is supported when no separately owned current extraction scope conflicts. New extraction heads supersede their old revisions. Incomplete revisions require linking recovery before further content changes; complete proposals with blocking whole-set findings remain correctable when the server permits revision.

## Verification

The UI tests use Arrange / Act / Assert: arrange saved proposals and server responses, act through labeled React DOM controls, and assert the outgoing request and visible successor state. API/revision tests exercise authenticated authorization and real PostgreSQL persistence with deterministic provider modules.

Run the focused verification from the repository root with the local PostgreSQL test database available:

```bash
npx vitest run tests/accuracy-assembly-api.test.ts tests/accuracy-assembly-revision.test.ts tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts --silent
npm run typecheck
npx eslint src/components/accuracy/assembly-history.tsx src/components/accuracy/assembly-revision-form.tsx tests/accuracy-assembly-revision-ui.test.ts tests/accuracy-assembly-review-ui.test.ts tests/accuracy-assembly-ui.test.ts
git diff --check
```

The controller runs the full project suite after independent review. Focused verification covers required reasons, add/edit/remove payloads, unchanged fields and all provenance spans, changed-quote offsets, source quote validation, human/baseline labels, successor/baseline navigation, incomplete-link retry, independent server permissions, stale-control invalidation, submission serialization, and workspace-switch response handling.

For a manual browser check, sign in with each supported role and inspect the same workspace. Tab through a contributor gap/tactic form, choose evidence by its displayed text, save a revision, compare its baseline, and review only the freshly loaded successor. Verify that an unauthorized role can inspect but has no mutation controls. Exercise provider failure and a competing contributor change in a test workspace, checking the announced error, disabled controls, refresh, and retry path.

## Limits

Automated UI verification uses jsdom, a simulated DOM. It does not establish browser visual layout, complete keyboard/screen-reader behavior, mobile layout, or real-provider accuracy. Deterministic checks validate structure and evidence support, not clinical correctness or extraction recall. Real provider behavior and large-history performance require separate evaluation. The existing provider runner's retry bound and persisted-running-attempt conflicts still apply.
