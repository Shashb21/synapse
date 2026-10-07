import { getWorkspace } from "@/accuracy/store/tenant";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";

/** Real source/block/quote fixture for source-backed positive coverage scenarios. */
export async function coverageProvenance(workspace_id: string, quote: string) {
  const workspace = await getWorkspace(workspace_id);
  if (!workspace) throw new Error("Coverage fixture workspace missing");
  const source = await insertSourceFile({ workspace_id, org_id: workspace.org_id,
    filename: "coverage-fixture.txt", mime: "text/plain", checksum: crypto.randomUUID() });
  const block_id = `${source.id}-coverage`;
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "fixture", blocks: [
    { id: block_id, source_file_id: source.id, index: 0, kind: "prose", heading: null, text: quote },
  ] });
  return [{ source_file_id: source.id, block_id, quote }];
}
