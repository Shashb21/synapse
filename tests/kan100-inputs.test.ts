import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { freezeReferencePack, type FreezeReferencePackInput } from "@/accuracy/eval/benchmark/inputs";
const bytes = Buffer.from("synthetic original");
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function fixture(): FreezeReferencePackInput {
  return {
    packId: "synthetic", filename: "synthetic.pptx", originalFile: bytes,
    config: { referenceVersion: "ref-1", sourceCodeVersion: "code-1", sources: [{ packId: "synthetic", hash: digest(bytes), blocks: 90, complete: true, synthetic: true, inputTokens: null }] },
    parserVersion: "local-1", frozenAt: "2026-10-13T12:00:00Z",
    blocks: Array.from({ length: 90 }, (_, i) => ({ id: `B${i}`, location: { kind: "slide", ref: `Slide ${i + 1}` }, text: `Synthetic content ${i}`, kind: "bullet" })),
    gold: { needs: [{ id: "N1", statement: "Synthetic need", blockIds: ["B89"] }], tactics: [{ id: "T1", statement: "Synthetic activity", blockIds: ["B0"] }] },
  };
}
describe("frozen reference inputs", () => {
  it("preserves complete blocks, separate stages, identities and deterministic hashes", async () => {
    const input = fixture();
    const a = await freezeReferencePack(input); const b = await freezeReferencePack(fixture());
    expect(a).toEqual(b); expect(a.source.blocks).toEqual(input.blocks);
    expect(a.source.blocks).toHaveLength(90); expect(a.gold.needs.items).toHaveLength(1);
    expect(a.gold.tactics.items).toHaveLength(1); expect(a.originalFileHash).toBe(digest(bytes));
    expect(a.gold.needs.review).toEqual({ status: "pending" });
  });
  it("retains parsing losses in the denominator", async () => {
    const input = fixture(); input.gold.needs.push({ id: "N2", statement: "Lost content", blockIds: [], parsingLoss: { reason: "Chart absent from parser", location: { kind: "slide", ref: "Slide 91" } } });
    const result = await freezeReferencePack(input);
    expect(result.gold.needs.items).toHaveLength(2); expect(result.gold.needs.parsingLossIds).toEqual(["N2"]);
  });
  it("requires explicit stage-specific version-bound review", async () => {
    const input = fixture(); input.gold.needsReview = { status: "approved", reviewerId: "human-1", reviewedAt: input.frozenAt, referenceVersion: "ref-1" };
    const result = await freezeReferencePack(input);
    expect(result.gold.needs.review.status).toBe("approved"); expect(result.gold.tactics.review.status).toBe("pending");
    input.gold.needsReview.referenceVersion = "old";
    await expect(freezeReferencePack(input)).rejects.toThrow();
  });
  it("detaches and recursively freezes output; content changes update hashes", async () => {
    const input = fixture(); const a = await freezeReferencePack(input);
    input.blocks![0].text = "changed"; input.gold.needs[0].statement = "changed need";
    expect(a.source.blocks[0].text).toBe("Synthetic content 0");
    expect(() => { a.source.blocks[0].text = "mutation"; }).toThrow();
    const b = await freezeReferencePack(input);
    expect(a.sourceHash).not.toBe(b.sourceHash); expect(a.referenceHash).not.toBe(b.referenceHash); expect(a.packHash).not.toBe(b.packHash);
  });
  it.each(["missing-id", "duplicate-id", "bad-link", "duplicate-gold", "bad-hash", "block-count", "incomplete", "missing-reviewer", "invalid-time", "unmarked-loss"])("rejects %s", async (kind) => {
    const input = fixture();
    if (kind === "missing-id") input.blocks![0].id = " ";
    if (kind === "duplicate-id") input.blocks![1].id = "B0";
    if (kind === "bad-link") input.gold.needs[0].blockIds = ["absent"];
    if (kind === "duplicate-gold") input.gold.needs.push(input.gold.needs[0]);
    if (kind === "bad-hash") input.config.sources[0].hash = "bad";
    if (kind === "block-count") input.config.sources[0].blocks = 80;
    if (kind === "incomplete") input.config.sources[0].complete = false;
    if (kind === "missing-reviewer") input.gold.needsReview = { status: "approved", reviewerId: "", reviewedAt: input.frozenAt, referenceVersion: "ref-1" };
    if (kind === "invalid-time") input.frozenAt = "yesterday";
    if (kind === "unmarked-loss") input.gold.needs[0].blockIds = [];
    await expect(freezeReferencePack(input)).rejects.toThrow();
  });
  it("prepares every local PPTX slide without external services", async () => {
    const zip = new JSZip();
    for (let i = 1; i <= 90; i++) zip.file(`ppt/slides/slide${i}.xml`, `<a:t>Synthetic ${i}</a:t>`);
    const input = fixture(); input.originalFile = await zip.generateAsync({ type: "nodebuffer" });
    input.config.sources[0].hash = digest(input.originalFile); delete input.blocks;
    input.gold = { needs: [], tactics: [] };
    const result = await freezeReferencePack(input);
    expect(result.source.blocks).toHaveLength(90); expect(result.source.blocks[89].location.ref).toBe("Slide 90");
  });
  it("preserves literal whitespace and hashes object keys canonically", async () => {
    const input = fixture(); input.blocks![0].text = "  Literal support\n ";
    input.gold.needs[0].reference = { id: "original-row", number: 1 };
    const a = await freezeReferencePack(input);
    input.gold.needs[0].reference = { number: 1, id: "original-row" };
    const b = await freezeReferencePack(input);
    expect(a.source.blocks[0].text).toBe("  Literal support\n ");
    expect(a.referenceHash).toBe(b.referenceHash); expect(a.packHash).toBe(b.packHash);
  });
  it("keeps stage identities independent and rejects foreign packs", async () => {
    const input = fixture(); input.gold.tactics[0].id = "N1";
    const result = await freezeReferencePack(input);
    expect(result.gold.needs.items[0].id).toBe(result.gold.tactics.items[0].id);
    input.packId = "other-deck";
    await expect(freezeReferencePack(input)).rejects.toThrow();
  });
  it("rejects missing versions and reviews dated after freeze", async () => {
    const input = fixture(); input.parserVersion = "";
    await expect(freezeReferencePack(input)).rejects.toThrow();
    input.parserVersion = "local-1";
    input.gold.needsReview = { status: "approved", reviewerId: "human-1", reviewedAt: "2026-10-14T12:00:00Z", referenceVersion: "ref-1" };
    await expect(freezeReferencePack(input)).rejects.toThrow();
  });
  it("rejects invalid local preparation", async () => {
    const input = fixture(); delete input.blocks;
    await expect(freezeReferencePack(input)).rejects.toThrow();
  });
});
