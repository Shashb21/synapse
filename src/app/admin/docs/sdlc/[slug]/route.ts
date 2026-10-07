import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ownerGate } from "@/modules/auth/owner";
import { specDoc } from "@/components/admin/sdlc-docs";

export const runtime = "nodejs";

/** One spec as raw markdown. Only slugs in SPEC_DOCS resolve, each to the path the list names. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const denied = await ownerGate();
  if (denied) return denied;
  const { slug } = await params;
  const doc = specDoc(slug);
  if (!doc) {
    return NextResponse.json({ error: "Unknown spec" }, { status: 404 });
  }
  const body = await readFile(path.join(process.cwd(), doc.rel), "utf8");
  return new NextResponse(body, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
