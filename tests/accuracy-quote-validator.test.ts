import { describe, expect, it } from "vitest";
import { validateQuoteAgainstBlock } from "@/accuracy/store/quote-validator";

describe("accuracy quote validator", () => {
  it("accepts verbatim substrings", () => {
    const r = validateQuoteAgainstBlock({
      block: { text: "Plan includes Study VEL-REG-01 for registry." },
      quote: "Study VEL-REG-01",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects paraphrase quotes", () => {
    const r = validateQuoteAgainstBlock({
      block: { text: "Plan includes Study VEL-REG-01 for registry." },
      quote: "registry study VEL-REG-01 planned",
    });
    expect(r.ok).toBe(false);
  });
});
