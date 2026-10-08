import { describe, expect, it } from "vitest";
import { generatedItemFingerprint, isDownstreamClaim } from "@/accuracy/domain/item-history";

describe("generated item identity", () => {
  const quote = { source_file_id: "source", block_id: "block", quote: "same quote" };

  it("ignores generated ID and object key order while retaining all other fields", () => {
    const first = { id: "one", statement: "Question A", provenance: [quote], external_id: "x" };
    const reordered = { provenance: [{ quote: "same quote", block_id: "block", source_file_id: "source" }], external_id: "x", statement: "Question A", id: "two" };
    expect(generatedItemFingerprint("gap", first)).toBe(generatedItemFingerprint("gap", reordered));
    expect(generatedItemFingerprint("gap", { ...first, statement: "Question B" })).not.toBe(generatedItemFingerprint("gap", first));
    expect(generatedItemFingerprint("gap", { ...first, provenance: [{ ...quote, quote: "other" }] })).not.toBe(generatedItemFingerprint("gap", first));
  });

  it("distinguishes questions sharing a quote, types, and array order", () => {
    const first = { statement: "Question A", provenance: [quote, { ...quote, block_id: "other" }] };
    expect(generatedItemFingerprint("gap", first)).not.toBe(generatedItemFingerprint("gap", { ...first, statement: "Question B" }));
    expect(generatedItemFingerprint("gap", first)).not.toBe(generatedItemFingerprint("tactic", first));
    expect(generatedItemFingerprint("gap", first)).not.toBe(generatedItemFingerprint("gap", { ...first, provenance: [...first.provenance].reverse() }));
  });

  it("keeps review-only and retired claims out of downstream assemblies", () => {
    expect(isDownstreamClaim({ status: "draft", metadata: {} })).toBe(true);
    expect(isDownstreamClaim({ status: "draft", metadata: { history_only: true } })).toBe(false);
    expect(isDownstreamClaim({ status: "merged", metadata: {} })).toBe(false);
  });
});
