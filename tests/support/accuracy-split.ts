import { createOrganization, createWorkspace } from "@/accuracy/store/tenant";
import { applyClaimValidation, getClaim, insertClaim } from "@/accuracy/store/claim-store";
import { coveragePairRevisions, upsertCoverageDecision } from "@/accuracy/store/coverage-store";
import { coverageProvenance } from "./coverage-provenance";
import { newId } from "@/modules/kernel/ids";
import { readAccuracySplitInputs, type SplitProposal } from "@/accuracy/store/partial-split-store";

export const splitActor = { name: "Split reviewer", function: "heor" as const };
export async function splitFixture() {
  const org_id = await createOrganization("Split tests");
  const workspace_id = await createWorkspace({ org_id, name: "Split", slug: newId("split") });
  const evidence = await coverageProvenance(workspace_id, "Need outcomes and comparative evidence. A planned chart review covers outcomes; comparative evidence is missing.");
  const parent = await insertClaim({ workspace_id, claim_type: "gap", source_file_id: evidence[0].source_file_id,
    statement: "Need outcomes and comparative evidence.", metadata: { provenance: evidence, priority: "high", priority_validated: true } });
  const tactic = await insertClaim({ workspace_id, claim_type: "tactic", source_file_id: evidence[0].source_file_id,
    statement: "Chart review covers outcomes.", metadata: { provenance: evidence, tactic_status: "planned" } });
  await applyClaimValidation({ workspace_id, claim_ids: [parent.id, tactic.id], action: "validate", actor: splitActor, rationale: "Verified source facts" });
  await upsertCoverageDecision({ workspace_id, gap_id: parent.id, tactic_id: tactic.id, ...await coveragePairRevisions({ workspace_id, gap_id: parent.id, tactic_id: tactic.id }),
    overall: "partial", evidence: [evidence[0].block_id], actor: splitActor, rationale: "Outcomes covered, comparator remains" });
  const inputs = await readAccuracySplitInputs({ workspace_id, gap_id: parent.id });
  const proposal: SplitProposal = { ...inputs.revisions, workspace_id, parent_gap_id: parent.id, confirmed: true,
    addressed_name: "Outcome evidence", addressed_statement: "Need outcome evidence from the chart review.", addressed_tactic_ids: [tactic.id],
    open_name: "Comparative evidence", open_statement: "Need comparative evidence against standard care.", uncovered_dimensions: ["comparator"],
    addressed_evidence: evidence, open_evidence: evidence, confidence: 90, rationale: ["Chart review closes outcomes only"] };
  return { workspace_id, org_id, parent: (await getClaim(workspace_id, parent.id))!, tactic, evidence, proposal };
}
