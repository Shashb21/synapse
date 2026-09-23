import { describe, expect, it } from "vitest";
import { resolveParsePolicy } from "@/accuracy/modules/parse/parse-policy";

describe("accuracy parse policy", () => {
  it("routes pdf to llamaparse", () => {
    expect(resolveParsePolicy({ filename: "medical-plan.pdf", mime: "application/pdf" }).parser).toBe(
      "llamaparse",
    );
  });

  it("routes pptx to llamaparse even when Llama key is absent", () => {
    const prev = process.env.LLAMA_CLOUD_API_KEY;
    delete process.env.LLAMA_CLOUD_API_KEY;
    const policy = resolveParsePolicy({
      filename: "deck.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(policy.parser).toBe("llamaparse");
    expect(policy.reason).toBe("pptx_needs_llama");
    if (prev !== undefined) process.env.LLAMA_CLOUD_API_KEY = prev;
  });

  it("routes pptx to llamaparse with key reason when keyed", () => {
    const prev = process.env.LLAMA_CLOUD_API_KEY;
    process.env.LLAMA_CLOUD_API_KEY = "test-key";
    const policy = resolveParsePolicy({
      filename: "deck.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(policy.parser).toBe("llamaparse");
    expect(policy.reason).toBe("pptx_with_llama_key");
    if (prev !== undefined) process.env.LLAMA_CLOUD_API_KEY = prev;
    else delete process.env.LLAMA_CLOUD_API_KEY;
  });

  it("routes docx to local structured", () => {
    expect(
      resolveParsePolicy({
        filename: "notes.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }).parser,
    ).toBe("local_structured");
  });
});
