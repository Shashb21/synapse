import { ingestBuffer } from "@/lib/ingest/llamaparse";
import { hasAnthropicKey, hasLlamaCloudKey, providerStatus } from "@/lib/config";
import { addDocument, dashboardView } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Attach a PPTX, DOCX, XLSX, or PDF file." },
      { status: 400 },
    );
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const { document, parserUsed, llamaError } = await ingestBuffer({
      filename: file.name,
      buffer,
      mime: file.type,
    });
    if (document.blocks.length === 0) {
      return NextResponse.json(
        { error: "Parser returned no text. Try a native PPTX, DOCX, XLSX, or PDF." },
        { status: 422 },
      );
    }
    const state = await addDocument(document);
    const claudeUsed = state.insights.some(
      (i) =>
        i.source_document_id === document.id &&
        i.extractor_prompt_version === "v1.4-claude",
    );
    return NextResponse.json({
      parserUsed,
      llamaError: llamaError ?? null,
      extractor: claudeUsed ? "claude" : "local",
      providers: providerStatus(),
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

export async function GET() {
  return NextResponse.json({
    llama_configured: hasLlamaCloudKey(),
    anthropic_configured: hasAnthropicKey(),
    providers: providerStatus(),
  });
}
