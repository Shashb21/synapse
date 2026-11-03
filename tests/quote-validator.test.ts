import { describe, expect, it } from "vitest";
import { provenanceSpanSchema, validateProvenance, validateQuoteAgainstBlock } from "@/lib/ingest/quote-validator";

describe("quote validation", () => {
  it.each([
    ["Study VEL-REG-01", { ok: true, normalized: "Study VEL-REG-01" }],
    ["  Study VEL-REG-01  ", { ok: true, normalized: "Study VEL-REG-01" }],
    ["Study\n VEL-REG-01", { ok: true, normalized: "Study\n VEL-REG-01" }],
    [" \n ", { ok: false, reason: "empty_quote" }],
    ["registry study VEL-REG-01 planned", { ok: false, reason: "quote_not_substring" }],
  ])("validates quote %j", (quote, expected) => {
    const block = { text: "Plan includes Study VEL-REG-01 for registry." };
    const result = validateQuoteAgainstBlock({ block, quote });
    expect(result).toEqual(expected);
  });

  it("collapses source whitespace while preserving trimmed quote whitespace", () => {
    const block = { text: "Plan includes Study\n\tVEL-REG-01 for registry." };
    const quote = " Study  VEL-REG-01 ";
    const result = validateQuoteAgainstBlock({ block, quote });
    expect(result).toEqual({ ok: true, normalized: "Study  VEL-REG-01" });
  });

  it.each([
    [{}, { ok: true }],
    [{ block_id: "other" }, { ok: false, reason: "block_id_mismatch" }],
    [{ source_file_id: "other" }, { ok: false, reason: "source_file_mismatch" }],
    [{ block_id: "other", source_file_id: "other" }, { ok: false, reason: "block_id_mismatch" }],
    [{ quote: "" }, { ok: false, reason: "empty_quote" }],
    [{ quote: "invented" }, { ok: false, reason: "quote_not_substring" }],
  ])("validates provenance overrides %j", (overrides, expected) => {
    const block = { id: "block-1", source_file_id: "source-1", text: "Study VEL-REG-01" };
    const span = provenanceSpanSchema.parse({ block_id: block.id, source_file_id: block.source_file_id, quote: block.text, ...overrides });
    const result = validateProvenance({ block, span });
    expect(result).toEqual(expected);
  });

  it("keeps offsets optional and does not use them to validate the quote", () => {
    const block = { id: "block-1", source_file_id: "source-1", text: "Study VEL-REG-01" };
    const span = provenanceSpanSchema.parse({ block_id: block.id, source_file_id: block.source_file_id, quote: block.text, char_start: 100, char_end: 1 });
    const result = validateProvenance({ block, span });
    expect(result).toEqual({ ok: true });
    expect(provenanceSpanSchema.safeParse({ ...span, char_start: -1 }).success).toBe(false);
  });
});
