# Assembly approval (KAN-38)

Open **Accuracy -> Ledger**, choose a workspace, and expand **Complete proposals**. List entries use a neutral **Complete proposal** label; inspect one to see its current review status. The review form is shown only after the full immutable proposal detail and review metadata load from the server.

The detail view shows the exact proposal fingerprint, live-head status, review status, deterministic findings, source scope, selected items, mappings and coverage. Approved and rejected decisions show the immutable reviewer, review time, rationale and advisory reasons. A rejected proposal pauses live use until a revised complete proposal is generated and approved.

Reviewers with contributor or Medical Affairs access can approve or reject a current pending proposal. Both decisions require a nonblank rationale. Every advisory finding requires an explicit acknowledgement and reason. Blocking deterministic findings disable approval, but rejection remains available so the reviewer can stop use of the proposal.

The UI sends the displayed fingerprint and the current expected review identity with every decision. Only one decision can be submitted across the panel at a time. After the server accepts a decision, the proposal list and detail are reloaded from the API. The old review form is hidden during detail refresh; if that request fails, **Retry proposal** loads a fresh detail before any further decision. If another reviewer decides first, the UI keeps the local proposal pending, shows the conflict, and asks the reviewer to refresh.

Verification:

```bash
npm test -- tests/accuracy-assembly-review-ui.test.ts
npm test -- tests/accuracy-assembly-ui.test.ts tests/accuracy-assembly-review-ui.test.ts
npm test
npm run typecheck
eslint src/components/accuracy/assembly-history.tsx tests/accuracy-assembly-review-ui.test.ts
git diff --check
```
