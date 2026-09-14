import { getState, resetState } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const state = await getState();
  return NextResponse.json({
    documents: state.documents.map((d) => ({
      id: d.id,
      filename: d.filename,
      title: d.title,
      stakeholder_function: d.stakeholder_function,
      parser: d.parser,
      ingested_at: d.ingested_at,
      blocks: d.blocks,
      fullText: d.fullText,
    })),
  });
}

export async function DELETE() {
  const state = await resetState();
  return NextResponse.json({ ok: true, documents: state.documents.length });
}
