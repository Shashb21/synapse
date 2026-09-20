import { NextResponse } from "next/server";
import { getExtractRun } from "@/lib/iegp/extract/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const found = await getExtractRun(id);
  if (!found) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const download = new URL(request.url).searchParams.get("download");
  if (download) {
    return new NextResponse(JSON.stringify(found, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${id}.json"`,
      },
    });
  }
  return NextResponse.json(found);
}
