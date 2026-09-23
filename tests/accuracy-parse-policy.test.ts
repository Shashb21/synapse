import { describe, expect, it } from "vitest";
import { resolveParsePolicy } from "@/accuracy/modules/parse/parse-policy";

describe("accuracy parse policy", () => {
  it("routes pdf to llamaparse", () => {
    expect(resolveParsePolicy({ filename: "medical-plan.pdf", mime: "application/pdf" }).parser).toBe(
      "llamaparse",
    );
  });

  it("routes pptx to local structured when Llama key is absent", () => {
    const prev = process.env.LLAMA_CLOUD_API_KEY;
    delete process.env.LLAMA_CLOUD_API_KEY;
    expect(
      resolveParsePolicy({
        filename: "deck.pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }).parser,
    ).toBe("local_structured");
    if (prev !== undefined) process.env.LLAMA_CLOUD_API_KEY = prev;
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
