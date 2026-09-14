import { ingestBuffer } from "@/lib/ingest/llamaparse";
import { addDocument, dashboardView } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Attach a PPTX, DOCX, or XLSX file." }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const { document, parserUsed } = await ingestBuffer({
      filename: file.name,
      buffer,
      mime: file.type,
    });
    if (document.blocks.length === 0) {
      return NextResponse.json(
        { error: "Parser returned no text. Try a native PPTX, DOCX, or XLSX." },
        { status: 422 },
      );
    }
    const state = await addDocument(document);
    return NextResponse.json({
      parserUsed,
      document: {
        id: document.id,
        filename: document.filename,
        title: document.title,
        stakeholder_function: document.stakeholder_function,
        parser: document.parser,
        blocks: document.blocks.length,
      },
      dashboard: dashboardView(state),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingest failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
