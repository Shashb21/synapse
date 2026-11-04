/** Owner-only selection of bundled demo files as private experiment sources. */
import { demoDocumentSchema } from "@/modules/development/schema";
import {
  listDemoDocuments,
  prepareDemoDocument,
} from "@/modules/development/demo-documents";
import {
  getExperiment,
  requireRevision,
  updateExperiment,
} from "@/modules/development/store";
import { body, guarded, json, type DraftContext } from "../../_shared";

/** List allowlisted demo files; the experiment must exist. */
export async function GET(_request: Request, context: DraftContext) {
  return guarded(async () => {
    const experiment = await getExperiment((await context.params).id);
    return json({ documents: listDemoDocuments(experiment) });
  });
}

/** Prepare and freeze exactly one bundled demo file. */
export async function POST(request: Request, context: DraftContext) {
  return guarded(async (actor) => {
    const input = await body(request, demoDocumentSchema),
      { id } = await context.params;
    const experiment = await getExperiment(id);
    requireRevision(experiment, input.revision);
    const prepared = await prepareDemoDocument(experiment, actor, input.demo_id);
    return json({
      experiment: await updateExperiment(id, input.revision, prepared),
    });
  });
}
