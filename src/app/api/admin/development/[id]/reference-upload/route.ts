/** Owner-only evaluator references, kept separate from generation sources. */
import { referenceUploadSchema } from "@/modules/development/schema";
import {
  getExperiment,
  requireRevision,
  updateExperiment,
} from "@/modules/development/store";
import { prepareReference } from "@/modules/development/documents";
import { body, guarded, json, type DraftContext } from "../../_shared";
/** Validate structured references or provisionally parse an expert PDF. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async (actor) => {
    const input = await body(request, referenceUploadSchema),
      { id } = await context.params;
    const experiment = await getExperiment(id);
    requireRevision(experiment, input.revision);
    const prepared = await prepareReference(experiment, actor, input);
    return json({
      experiment: await updateExperiment(id, input.revision, prepared),
    });
  });
}
