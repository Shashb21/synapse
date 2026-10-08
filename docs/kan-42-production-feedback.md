# Production feedback on complete proposals

Production feedback records what a contributor observed after an approved complete proposal was consumed by a successful production run. It belongs to the **exact saved proposal**, its historical approval decision, and that consumer run. A later revision has its own feedback history; feedback on an earlier proposal remains visible when that proposal is inspected.

## Record an observation

1. Open the workspace ledger, expand **Complete proposals**, and inspect the proposal that was used in production. The proposal's fingerprint and review status appear in its detail.
2. In **Production feedback**, inspect the eligible consumer runs. Each entry shows the run ID, time, approval review ID, and the item versions this proposal contributed. Follow the run link to inspect its details.
3. If your account has contributor access, choose a consumer run and a feedback category: accepted unchanged, edited, rejected, missing item, split or merged, or overridden.
4. Optionally check the consumed item versions the observation concerns. Leaving every checkbox unchecked means **all items this exact proposal contributed to the selected run**, not all items in the proposal or run. A partial selection refers only to the checked consumed item versions.
5. Enter a specific rationale and select **Record feedback**. The panel waits for the write and reloads the exact proposal before allowing another entry. If the reload fails, your entered rationale remains in the form; use **Retry feedback refresh** before recording more feedback.

The history shows the contributor, time, category, rationale, consumer run, approval, and each selected item's source and recorded evidence. Workspace readers can inspect this history. Only contributors can record a new observation. A superseded proposal may still receive feedback when a qualifying historical production run consumed it.

## What the record proves

Eligibility comes from the server's recorded production consumption and historical approval. The UI only offers runs that the server can tie to this exact proposal and lists the item versions consumed from it. Truncated or legacy consumption records whose bindings cannot be proved are ineligible for new feedback. An older proposal with no feedback still has a readable empty history, even when its legacy consumption proof is incomplete.

Feedback is an operational observation. It does **not** establish gold accuracy, a score, clinical correctness, or a new approval. Recording it does not change the proposal fingerprint, review decision, evaluation result, or gold metrics. When a historical record cannot be proven, use the underlying run and source records to investigate; do not infer consumption from a matching current head or a similar item title.
