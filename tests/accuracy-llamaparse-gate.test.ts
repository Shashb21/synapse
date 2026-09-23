import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestBuffer } from "@/lib/ingest/llamaparse";
import { LLAMA_PARSE_KEY_REQUIRED } from "@/lib/ingest/llama-gate";

const mockParseLocal = vi.fn();

vi.mock("@/lib/ingest/local-parse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/local-parse")>();
  return {
    ...actual,
    parseLocalDocument: (...args: unknown[]) => mockParseLocal(...args),
  };
});

function localDoc(filename: string, mime: string) {
  return {
    id: "DOC-local",
    filename,
    title: filename,
    stakeholder_function: "medical_affairs" as const,
    mime,
    parser: "local" as const,
    ingested_at: new Date().toISOString(),
    blocks: [
      {
        id: "DOC-local-B01",
        location: { kind: "page" as const, ref: "p.1" },
        text: "Need OS evidence",
        kind: "paragraph" as const,
      },
    ],
    fullText: "Need OS evidence",
  };
}

describe("LlamaParse env gate (no live Llama)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mockParseLocal.mockReset();
  });

  it("does not local-parse PDF/PPTX when the key is missing", async () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ingestBuffer({ filename: "plan.pdf", buffer: Buffer.from("%PDF"), mime: "application/pdf" }),
    ).rejects.toThrow(LLAMA_PARSE_KEY_REQUIRED);

    await expect(
      ingestBuffer({
        filename: "deck.pptx",
        buffer: Buffer.from("pptx"),
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).rejects.toThrow(LLAMA_PARSE_KEY_REQUIRED);

    expect(mockParseLocal).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still local-parses DOCX when the key is missing", async () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "");
    mockParseLocal.mockResolvedValue(
      localDoc(
        "notes.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    );
    const result = await ingestBuffer({
      filename: "notes.docx",
      buffer: Buffer.from("docx"),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(result.parserUsed).toBe("local");
    expect(mockParseLocal).toHaveBeenCalledOnce();
  });

  it("calls LlamaParse upload when the key is set (mocked fetch, no live job)", async () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: "unauthorized" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mockParseLocal.mockResolvedValue(localDoc("plan.pdf", "application/pdf"));

    const result = await ingestBuffer({
      filename: "plan.pdf",
      buffer: Buffer.from("%PDF"),
      mime: "application/pdf",
    });

    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("api.cloud.llamaindex.ai");
    expect(result.parserUsed).toBe("local");
    expect(result.llamaError).toMatch(/LlamaParse/i);
    expect(mockParseLocal).toHaveBeenCalledOnce();
  });
});
