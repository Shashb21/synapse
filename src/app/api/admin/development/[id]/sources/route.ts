/** Read-only discovery and frozen import from one authorized source workspace. */
import { sourceImportSchema } from "@/modules/development/schema";
import {
  discoverSources,
  snapshotWorkspaceSource,
} from "@/modules/development/documents";
import {
  getExperiment,
  requireRevision,
  updateExperiment,
} from "@/modules/development/store";
import { body, guarded, json, type DraftContext } from "../../_shared";
/** Discover source files only in the draft's bound workspace. */
export async function GET(_request: Request, context: DraftContext) {
  return guarded(async () =>
    json({
      sources: await discoverSources(
        await getExperiment((await context.params).id),
      ),
    }),
  );
}
/** Freeze existing original bytes and parsed blocks without customer writes. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async (actor) => {
    const input = await body(request, sourceImportSchema),
      { id } = await context.params;
    const experiment = await getExperiment(id);
    requireRevision(experiment, input.revision);
    const prepared = await snapshotWorkspaceSource(
      experiment,
      input.source_file_id,
      actor,
    );
    return json({
      experiment: await updateExperiment(id, input.revision, prepared),
    });
  });
}
