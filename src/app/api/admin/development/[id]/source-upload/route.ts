/** Owner-only private source preparation, isolated from customer ingestion. */
import { sourceUploadSchema } from "@/modules/development/schema";
import {
  getExperiment,
  requireRevision,
  updateExperiment,
} from "@/modules/development/store";
import { prepareSource } from "@/modules/development/documents";
import { body, guarded, json, type DraftContext } from "../../_shared";
/** Parse and freeze one private source snapshot. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async (actor) => {
    const input = await body(request, sourceUploadSchema),
      { id } = await context.params;
    const experiment = await getExperiment(id);
    requireRevision(experiment, input.revision);
    const prepared = await prepareSource(
      experiment,
      actor,
      input.filename,
      input.content_base64,
    );
    return json({
      experiment: await updateExperiment(id, input.revision, prepared),
    });
  });
}
