import { listRevisionEvaluations } from "@/modules/kernel/prompt-revision-evals";
/** Owner console report; only serializable agreement and revision metadata reaches the browser. */
import { AdminMain, AdminWorkspaceBar } from "@/components/admin/admin-page";
import { LearningConsole } from "@/components/platform/learning-console";
import { requireOwnerPage } from "@/modules/auth/owner";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";
import { listDecisionExamples } from "@/modules/kernel/decision-examples";
import { agreementSeries } from "@/modules/kernel/learning-agreement";
import { listPromptRevisions, revisionHistory } from "@/modules/kernel/prompt-revisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read the selected workspace after an independent page owner gate. */
export default async function LearningPage() {
  await requireOwnerPage();
  return withAdminWorkspace(async workspace => {
    const [examples, revisions, evaluations, history] = await Promise.all([
      listDecisionExamples({ workspace_id: workspace.id, limit: null }), listPromptRevisions(workspace.id), listRevisionEvaluations(workspace.id), revisionHistory(workspace.id),
    ]);
    const timestamps = examples.map(example => example.created_at).sort();
    return <AdminMain>
      <h1 className="mb-4 text-xl font-semibold">Decision learning</h1>
      <AdminWorkspaceBar workspace={workspace} path="/admin/learning" />
      <LearningConsole initial={{ evaluations, history: history as unknown as import("@/components/platform/learning-console").LearningReport["history"], bucket: "day", agreement: agreementSeries(examples, "day"), total: examples.length,
        date_range: timestamps.length ? { from: timestamps[0], to: timestamps[timestamps.length - 1] } : null,
        revisions: revisions.map(({ id, stage, parent_revision, instruction_text, creator, created_at, state, training_ids, heldout_ids }) => ({ id, stage, parent_revision, instruction_text, creator, created_at, state, training_count: training_ids.length, heldout_count: heldout_ids.length })),
      }} />
    </AdminMain>;
  });
}
