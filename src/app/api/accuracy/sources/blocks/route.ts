import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { readParseBlocks } from "@/accuracy/store/parse-store";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

/**
 * GET /api/accuracy/sources/blocks?workspace_id=…&source_file_id=…
 * Verbatim parse blocks for Sources quote-audit preview (ordered by index).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspace_id = url.searchParams.get("workspace_id")?.trim() ?? "";
    const source_file_id = url.searchParams.get("source_file_id")?.trim() ?? "";
    if (!workspace_id) {
      return NextResponse.json({ ok: false, error: "workspace_id is required" }, { status: 400 });
    }
    if (!source_file_id) {
      return NextResponse.json({ ok: false, error: "source_file_id is required" }, { status: 400 });
    }

    const org_id = await getWorkspaceOrgId(workspace_id);
    if (!org_id) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }

    const sources = await listSourceFiles(workspace_id);
    const source = sources.find((row) => row.id === source_file_id);
    if (!source) {
      return NextResponse.json({ ok: false, error: "Unknown source_file_id" }, { status: 404 });
    }

    const rows = await readParseBlocks(workspace_id, source_file_id);
    const blocks = [...rows]
      .sort((a, b) => a.index - b.index)
      .map((row) => ({
        id: row.id,
        index: row.index,
        kind: row.kind,
        heading: row.heading,
        text: row.text,
        parser: row.parser,
      }));

    return NextResponse.json({
      ok: true,
      workspace_id,
      source_file_id,
      filename: source.filename,
      block_count: blocks.length,
      parser: blocks[0]?.parser ?? null,
      blocks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load parse blocks";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
