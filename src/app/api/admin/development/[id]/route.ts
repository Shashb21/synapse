/** Owner-only reopening and concurrency-safe draft saves. */
import { saveDraftSchema } from "@/modules/development/schema";
import { getExperiment, updateExperiment } from "@/modules/development/store";
import { body, guarded, json, type DraftContext } from "../_shared";
/** Reopen immutable snapshots and the latest draft revision. */
export async function GET(_request: Request, context: DraftContext) {
  return guarded(async () =>
    json({ experiment: await getExperiment((await context.params).id) }),
  );
}
/** Rename a draft only when the browser's revision remains current. */
export async function PATCH(request: Request, context: DraftContext) {
  return guarded(async () => {
    const input = await body(request, saveDraftSchema),
      { id } = await context.params;
    await getExperiment(id);
    return json({
      experiment: await updateExperiment(id, input.revision, {
        name: input.name,
      }),
    });
  });
}
