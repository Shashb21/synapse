/** Source identity decisions using fictional passages and model-written questions. */
import { describe, expect, it } from "vitest";
import { currentSourceFindingKey, reclassifiedFindings, sourceFindingKey } from "@/lib/ingest/source-findings";
import { supportingBlockId } from "@/lib/ingest/manual-blocks";

describe("extraction finding identity", () => {
  const key = (question: string, kind = "survival") =>
    sourceFindingKey("rowan-source", "Participants raised survival and admission questions.", kind, question);

  it("matches a changed category and question framing to the sole recorded question", () => {
    const old = key("What is the comparative survival?");
    const current = key("What data are available on comparative survival?", "other");
    expect(reclassifiedFindings([current], [old]).get(current)).toBe(old);
    expect(currentSourceFindingKey(JSON.stringify(["rowan-source", "a full quote", "outcome", "What is survival?"])))
      .toBe(sourceFindingKey("rowan-source", "A full quote", "outcome", "survival"));
  });

  it("keeps different questions from a passage when its recorded question is also present", () => {
    const old = key("What is the comparative survival?");
    const added = key("What is the admission rate?");
    expect(reclassifiedFindings([old, added], [old]).size).toBe(0);
  });

  it("requires identifiable source evidence before reusing a different activity name", () => {
    const named = (name?: string) => sourceFindingKey("s", "A registry follows treatment outcomes.", "registry", "What is safety?", name);
    const original = named("Alpha registry"), ungrounded = named("Beta registry");
    expect(() => reclassifiedFindings([ungrounded], [original])).toThrow(/unresolved activity/);
    expect(() => reclassifiedFindings([original, ungrounded], [original])).toThrow(/unresolved activity/);
    expect(() => reclassifiedFindings([original, ungrounded], [named()])).toThrow(/unresolved activity/);
  });

  it.each([
    ["The North Registry and the North Extension Registry both track safety.", "different"],
    ["The North Registry tracks safety, whereas the North Extension Registry tracks mortality.", "different"],
    ["The North Registry concluded. The North Extension Registry tracks safety.", "unresolved"],
  ])("preserves separately cited names when the passage says %s", (quote, relationship) => {
    const keyFor = (name: string) => sourceFindingKey("s", quote, "registry", "What is safety?", name);
    const old = keyFor("North Registry"), incoming = keyFor("North Extension Registry");
    const reconcile = () => reclassifiedFindings([incoming], [old]);
    if (relationship === "unresolved") expect(reconcile).toThrow(/unresolved activity/);
    else expect(reconcile().has(incoming)).toBe(false);
  });

  it("requires resolution before a different question on an already recorded passage can overwrite or duplicate a decision", () => {
    expect(() => reclassifiedFindings([key("How long do people live?")], [key("What is survival?")]))
      .toThrow(/previously recorded passage/);
  });
});

it("resolves a full quotation after shared prefixes and retains only an unambiguous block", () => {
  const prefix = "Rowan participants described their experience. ".repeat(4);
  const blocks = [{id: "a", text: prefix + "Full response."}, {id: "b", text: prefix + "Partial response."}];
  expect(supportingBlockId(blocks, prefix + "Partial response.")).toBe("b");
  expect(supportingBlockId(blocks, prefix)).toBeNull();
  expect(supportingBlockId(blocks, prefix, "b")).toBe("b");
});
