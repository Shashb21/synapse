/** Owner-only saved Development experiment collection. */
import { createDraftSchema } from "@/modules/development/schema";
import { createExperiment, listExperiments } from "@/modules/development/store";
import { withAdminWorkspace } from "@/modules/workspaces/admin-context";
import { body, guarded, json } from "./_shared";
/** List saved experiment drafts. */
export async function GET() {
  return guarded(async () => json({ experiments: await listExperiments() }));
}
/** Create a draft with an immutable source-workspace binding. */
export async function POST(request: Request) {
  return guarded(async (actor) => {
    const input = await body(request, createDraftSchema);
    if (input.source_workspace_id)
      await withAdminWorkspace(
        async () => undefined,
        input.source_workspace_id,
      );
    return json(
      {
        experiment: await createExperiment(
          input.name,
          input.source_workspace_id,
          actor,
        ),
      },
      201,
    );
  });
}
