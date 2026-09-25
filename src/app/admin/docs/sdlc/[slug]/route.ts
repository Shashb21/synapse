import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ownerGate } from "@/modules/auth/owner";
import { SDLC_DOCS } from "@/components/admin/sdlc-docs";

export const runtime = "nodejs";

const ALLOWED = new Set<string>(SDLC_DOCS);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const denied = await ownerGate();
  if (denied) return denied;
  const { slug } = await params;
  if (!ALLOWED.has(slug)) {
    return NextResponse.json({ error: "Unknown spec" }, { status: 404 });
  }
  const file = path.join(process.cwd(), "docs", "sdlc", slug);
  const body = await readFile(file, "utf8");
  return new NextResponse(body, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
