/** Test fixture exercising the production successor/review owners, never bypassing their gates. */
import { listAssemblies, readAssembly } from "@/accuracy/store/assembly-store";
import { assemblyReviewState, reviewAssembly } from "@/accuracy/store/assembly-review-store";
import { currentRevisionAssemblyId } from "@/accuracy/store/assembly-revision-store";
import { createAssemblyRevision } from "@/accuracy/kernel/assembly-revision";
import { getWorkspace } from "@/accuracy/store/tenant";
import type { updateClaim } from "@/accuracy/store/claim-edit";
import { getClaim } from "@/accuracy/store/claim-store";
import { needGapSchema } from "@/accuracy/modules/need-extract/module";
import { inventoryTacticSchema } from "@/accuracy/modules/inventory-extract/module";

const reviewer = { subject: "source-reviewer", provider: "fixture-idp", role: "contributor" as const,
  actor: { name: "Source reviewer", function: "medical_affairs" as const } };
export async function approveSourceAssembly(workspace_id: string, assembly_id?: string) {
  const id = assembly_id ?? await currentRevisionAssemblyId(workspace_id, (await listAssemblies(workspace_id))[0].id);
  const state = await assemblyReviewState(workspace_id, id);
  if (state.status !== "approved") await reviewAssembly({ workspace_id, assembly_id: id,
    expected_fingerprint: state.fingerprint, expected_review_id: state.expected_review_id, decision: "approve",
    rationale: "Reviewed exact source evidence and pending limitations", reviewer,
    advisory_overrides: state.advisories.map(f => ({ code: f.code, item_version_ids: f.item_version_ids, reason: "Reviewed this explicit limitation" })) });
  return (await readAssembly(workspace_id, id))!;
}
export async function reviseSourceClaim(args: Parameters<typeof updateClaim>[0]) {
  const parent = await approveSourceAssembly(args.workspace_id);
  const item = parent.items.find(item => item.canonical_claim_id === args.claim_id)!;
  const payload: Record<string, unknown> = { ...item.payload, ...args.patch,
    ...(args.patch.structured ? { structured: { ...(item.payload.structured as object), ...args.patch.structured } } : {}) };
  if (item.claim_type === "tactic") {
    if (args.patch.tactic_status) {
      payload.status = args.patch.tactic_status;
      payload.structured = { ...(payload.structured as object), lifecycle: { state: "unknown", value: null, reason: "human_edit_without_field_evidence", provenance: [] } };
    } else if (args.patch.structured && "lifecycle" in args.patch.structured && args.patch.structured.lifecycle?.state === "known") {
      payload.status = args.patch.structured.lifecycle.value;
    }
  }
  const content = item.claim_type === "gap"
    ? { claim_type: "gap" as const, source_file_id: item.source_file_id, payload: needGapSchema.omit({ id: true }).parse(payload) }
    : { claim_type: "tactic" as const, source_file_id: item.source_file_id, payload: inventoryTacticSchema.omit({ id: true }).parse(payload) };
  const workspace = (await getWorkspace(args.workspace_id))!;
  const saved = await createAssemblyRevision({ workspace_id: args.workspace_id, org_id: workspace.org_id,
    parent_assembly_id: parent.id, expected_head_id: parent.id, expected_fingerprint: parent.fingerprint,
    author: { ...reviewer, actor: args.actor }, change: { action: "edit", item_version_id: item.id, reason: args.rationale, content } });
  await approveSourceAssembly(args.workspace_id, saved.assembly.id);
  return (await getClaim(args.workspace_id, args.claim_id))!;
}
