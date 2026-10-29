/** Seeds real source text for store tests that persist cited claims. */
import { insertSourceFile } from "@/accuracy/store/source-store";
import { persistParseBlocks } from "@/accuracy/store/parse-store";

/** Return evidence spans whose quotes exist in the requested workspace. */
export async function seedAccuracyEvidence(workspace_id: string, quotes: string[]) {
  const source = await insertSourceFile({ workspace_id, filename: "test-evidence.txt", mime: "text/plain", checksum: "fixture-evidence" });
  const blocks = quotes.map((text, index) => ({ id: `${source.id}-B${index + 1}`, source_file_id: source.id, index, kind: "prose" as const, heading: null, text }));
  await persistParseBlocks({ workspace_id, source_file_id: source.id, parser: "test", blocks });
  return blocks.map((block) => ({ source_file_id: source.id, block_id: block.id, quote: block.text }));
}
