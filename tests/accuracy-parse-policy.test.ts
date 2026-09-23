import { describe, expect, it } from "vitest";
import { resolveParsePolicy } from "@/accuracy/modules/parse/parse-policy";

describe("accuracy parse policy", () => {
  it("routes pdf to llamaparse", () => {
    expect(resolveParsePolicy({ filename: "medical-plan.pdf", mime: "application/pdf" }).parser).toBe(
      "llamaparse",
    );
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
