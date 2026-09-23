import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveParsePolicy } from "@/accuracy/modules/parse/parse-policy";
import { isLlamaParseSource } from "@/lib/ingest/llama-gate";

describe("accuracy parse policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes pdf to llamaparse", () => {
    expect(resolveParsePolicy({ filename: "medical-plan.pdf", mime: "application/pdf" }).parser).toBe(
      "llamaparse",
    );
  });

  it("marks pdf/pptx missing_key when Llama key is absent", () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "");
    const pptx = resolveParsePolicy({
      filename: "deck.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(pptx.parser).toBe("llamaparse");
    expect(pptx.reason).toBe("pptx_needs_llama");
    expect(pptx.missing_key).toBe(true);

    const pdf = resolveParsePolicy({ filename: "plan.pdf", mime: "application/pdf" });
    expect(pdf.parser).toBe("llamaparse");
    expect(pdf.reason).toBe("pdf_needs_llama");
    expect(pdf.missing_key).toBe(true);
  });

  it("routes pptx to llamaparse with key reason when keyed", () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "test-key");
    const policy = resolveParsePolicy({
      filename: "deck.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(policy.parser).toBe("llamaparse");
    expect(policy.reason).toBe("pptx_with_llama_key");
    expect(policy.missing_key).toBeUndefined();
  });

  it("routes docx and text to local structured without a Llama key", () => {
    vi.stubEnv("LLAMA_CLOUD_API_KEY", "");
    expect(
      resolveParsePolicy({
        filename: "notes.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toMatchObject({ parser: "local_structured", reason: "docx_text_or_sheet" });
    expect(
      resolveParsePolicy({ filename: "memo.txt", mime: "text/plain" }).parser,
    ).toBe("local_structured");
  });

  it("detects LlamaParse sources by filename and mime", () => {
    expect(isLlamaParseSource("plan.pdf")).toBe(true);
    expect(isLlamaParseSource("deck.PPTX")).toBe(true);
    expect(isLlamaParseSource("legacy.ppt")).toBe(true);
    expect(isLlamaParseSource("notes.docx")).toBe(false);
    expect(isLlamaParseSource("notes.txt", "text/plain")).toBe(false);
  });
});
