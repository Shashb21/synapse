import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { toParseBlockPreviews } from "@/accuracy/store/parse-preview";
import { readParseBlocks } from "@/accuracy/store/parse-store";
import { getSourceFile } from "@/accuracy/store/source-store";
import { getWorkspace } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

/**
 * Verbatim parse-block preview for one source file.
 * Scoped to workspace + source so BeOne gold packs never mix.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get("workspace_id")?.trim() ?? "";
  const source_file_id = url.searchParams.get("source_file_id")?.trim() ?? "";
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }
  if (!source_file_id) {
    return NextResponse.json({ error: "source_file_id required" }, { status: 400 });
  }

  const workspace = await getWorkspace(workspace_id);
  if (!workspace) {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
  }
  const source = await getSourceFile(workspace_id, source_file_id);
  if (!source) {
    return NextResponse.json({ error: "Unknown source file" }, { status: 404 });
  }

  const stored = await readParseBlocks(workspace_id, source_file_id);
  return NextResponse.json({
    ok: true,
    workspace_id,
    source_file_id,
    filename: source.filename,
    reference_pack_id: source.reference_pack_id,
    block_count: stored.length,
    blocks: toParseBlockPreviews(stored),
  });
}
