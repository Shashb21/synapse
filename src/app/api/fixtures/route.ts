import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAllFixtures } from "@/lib/seed/build-files";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const files = await buildAllFixtures();
  const dir = path.join(process.cwd(), "public", "fixtures");
  try {
    await mkdir(dir, { recursive: true });
    await Promise.all(
      files.map((f) => writeFile(path.join(dir, f.filename), f.buffer)),
    );
  } catch {
    // read-only env
  }
  return NextResponse.json({
    files: files.map((f) => ({
      filename: f.filename,
      bytes: f.buffer.length,
      href: `/fixtures/${encodeURIComponent(f.filename)}`,
    })),
  });
}
