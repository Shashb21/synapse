import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED = new Set([
  "01-requirements.md",
  "02-architecture.md",
  "03-design.md",
  "04-tdd.md",
  "05-process.md",
  "06-eval-protocol.md",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
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
