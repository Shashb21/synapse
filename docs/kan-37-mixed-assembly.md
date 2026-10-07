# Mixed assembly review (KAN-37)

Open **Accuracy -> Ledger**, choose a workspace, and expand **Complete proposals**. The panel reads saved assemblies only after disclosure. Each proposal is an immutable agent result: exact selected gap and tactic versions, selection reasons, source scope, run/snapshot lineage, links, coverage outcomes and deterministic check findings.

Assemblies are **unapproved proposals**. The deterministic ruling means the saved structure, references and source evidence passed or blocked the implemented checks for that exact set. It is not an accuracy score, a benchmark result, or proof that every relevant item was found.

Lineage labels identify where each selected item came from. A selected raw version shows its source, extraction run, snapshot, iteration and item index. A judged final output with no snapshot is labeled **Judged final output (no snapshot)** rather than inventing missing origin data. Selection reasons are the agent's reasons for the proposed version, separate from future human review reasons.

Mappings are version-bound links from selected gap versions to selected tactic versions. An uncovered gap is shown explicitly when no supported mapping exists for that selected gap. Coverage rows retain their run ID and mode. Stub coverage is labeled advisory structure only; non-relevant outcomes remain visible and do not count as supported mappings.

Assembly creation and reads use authenticated sessions and authorized workspaces. Production extraction/resume and assembly inspection reject signed-out requests; unsigned typed-name demo initiation now receives 401. This matches the approved safety boundary: authenticated initiation, authorized reads and signed-out write rejection. Do not restore unsigned generation.

KAN-38 owns approval, rejection, warning overrides and downstream consumption of the exact proposal. KAN-39 owns human add/remove/edit controls and requires a reason for each change. Inspecting a proposal in KAN-37 does not select versions manually, approve content, change ledger eligibility, validate claims or rewrite the agent result. Final review sees the ledger ruling and the scoped review finding for the exact assembly under inspection.
