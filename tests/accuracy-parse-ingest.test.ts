import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestFile } from "@/accuracy/modules/parse/ingest-file";
import { blocksFromParsedDocument, readParseBlocks } from "@/accuracy/store/parse-store";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";

const mockIngestBuffer = vi.fn();
const mockParseLocal = vi.fn();

vi.mock("@/lib/ingest/llamaparse", () => ({
  ingestBuffer: (...args: unknown[]) => mockIngestBuffer(...args),
}));

vi.mock("@/lib/ingest/local-parse", () => ({
  parseLocalDocument: (...args: unknown[]) => mockParseLocal(...args),
}));

function sampleDocument(parser: "llamaparse" | "local") {
  return {
    id: "DOC-test",
    filename: "plan.pdf",
    title: "Intro",
    stakeholder_function: "medical_affairs" as const,
    mime: "application/pdf",
    parser,
    ingested_at: new Date().toISOString(),
    blocks: [
      {
        id: "DOC-test-B01",
        location: { kind: "page" as const, ref: "p.1" },
        text: "Evidence plan overview",
        kind: "title" as const,
      },
      {
        id: "DOC-test-B02",
        location: { kind: "page" as const, ref: "p.1" },
        text: "Registry gap for biomarker subgroup",
        kind: "paragraph" as const,
      },
    ],
    fullText: "Evidence plan overview",
  };
}

describe("accuracy parse ingest", () => {
  beforeEach(() => {
    mockIngestBuffer.mockReset();
    mockParseLocal.mockReset();
  });

  it("routes llamaparse policy through ingestBuffer", async () => {
    mockIngestBuffer.mockResolvedValue({
      document: sampleDocument("llamaparse"),
      parserUsed: "llamaparse",
    });
    const result = await ingestFile({
      policy: { parser: "llamaparse", reason: "pdf_or_pptx" },
      filename: "plan.pdf",
      mime: "application/pdf",
      buffer: Buffer.from("fake-pdf"),
    });
    expect(mockIngestBuffer).toHaveBeenCalledOnce();
    expect(mockParseLocal).not.toHaveBeenCalled();
    expect(result.effectiveParser).toBe("llamaparse");
    expect(result.document.blocks).toHaveLength(2);
  });

  it("routes docx policy through local parse only", async () => {
    mockParseLocal.mockResolvedValue({
      ...sampleDocument("local"),
      filename: "notes.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const result = await ingestFile({
      policy: { parser: "local_structured", reason: "docx_text_or_sheet" },
      filename: "notes.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("fake-docx"),
    });
    expect(mockParseLocal).toHaveBeenCalledOnce();
    expect(mockIngestBuffer).not.toHaveBeenCalled();
    expect(result.effectiveParser).toBe("local_structured");
  });

  it("maps parsed block kinds for the parse store", () => {
    const rows = blocksFromParsedDocument({
      workspace_id: "ws-1",
      source_file_id: "src-1",
      blocks: sampleDocument("local").blocks,
    });
    expect(rows[0]!.kind).toBe("heading");
    expect(rows[1]!.kind).toBe("prose");
    expect(rows[0]!.heading).toBe("p.1");
  });
});

describe("accuracy parse module persistence", () => {
  beforeEach(() => {
    mockIngestBuffer.mockReset();
    mockParseLocal.mockReset();
  });

  it("persists blocks from mocked ingest", async () => {
    mockIngestBuffer.mockResolvedValue({
      document: sampleDocument("llamaparse"),
      parserUsed: "llamaparse",
    });

    registerAccuracyStack();
    const workspace_id = `ws-parse-${Date.now()}`;
    const source_file_id = `src-parse-${Date.now()}`;

    const result = await runAccuracyModule({
      call_kind: "parse",
      input: {
        workspace_id,
        source_file_id,
        filename: "plan.pdf",
        mime: "application/pdf",
        content_base64: Buffer.from("fake-pdf").toString("base64"),
      },
      actor: { name: "test", function: "medical_affairs" },
      org_id: "org-test",
      workspace_id,
    });

    expect((result.output as { block_count: number }).block_count).toBe(2);
    const stored = await readParseBlocks(workspace_id, source_file_id);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.parser).toBe("llamaparse");
    expect(stored[0]!.text).toContain("Evidence plan");
  });
});
