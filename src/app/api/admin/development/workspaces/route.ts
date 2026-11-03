/** Workspace choices for owner-only Development source binding. */
import { listAllWorkspaces } from "@/modules/workspaces/store";
import { guarded, json } from "../_shared";
/** List authorized workspace names without exposing infrastructure details. */
export async function GET() {
  return guarded(async () =>
    json({
      workspaces: (await listAllWorkspaces()).map(({ id, name }) => ({
        id,
        name,
      })),
    }),
  );
}
