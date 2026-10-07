import { ownerGate } from "@/modules/auth/owner";
import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { countParseBlocks, listSourceFiles } from "@/accuracy/store/source-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

export async function GET(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  const workspace_id = new URL(req.url).searchParams.get("workspace_id")?.trim();
  if (!workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }
  const sources = await listSourceFiles(workspace_id);
  const withBlocks = await Promise.all(
    sources.map(async (source) => ({
      ...source,
      block_count: await countParseBlocks(workspace_id, source.id),
    })),
  );
  return NextResponse.json({ sources: withBlocks });
}
