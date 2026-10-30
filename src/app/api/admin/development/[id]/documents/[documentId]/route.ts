/** Owner-authorized immutable original document retrieval. */
import { documentContent } from "@/modules/development/store";
import { guarded, json } from "../../../_shared";
/** Read original bytes only when the document belongs to this experiment. */
export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      id: string;
      documentId: string;
    }>;
  },
) {
  return guarded(async () => {
    const { id, documentId } = await context.params;
    return json(await documentContent(id, documentId));
  });
}
