import { describe, expect, it } from "vitest";
import { duplicateNote } from "@/modules/stages/s9-ideation/module";

/** KAN-69: an empty ideation run says why when every idea repeated a library tactic. */
describe("ideation duplicate note", () => {
  it("names the library tactic when every candidate was a duplicate", () => {
    const note = duplicateNote({
      withdrawn: [
        { note: "Duplicate of TAC-013 (EU5 FGFR2 testing practice survey); same question.", issues: ["duplicate"] },
        { note: "Overlaps the survey", issues: ["duplicate"] },
      ],
      rejected: [],
    });
    expect(note).toMatch(/Every idea repeated a tactic already in the library \(TAC-013\)/);
  });

  it("says nothing when some candidates failed for other reasons, or none were made", () => {
    expect(duplicateNote({ withdrawn: [{ note: "Design not runnable", issues: ["design"] }, { note: "dup", issues: ["duplicate"] }], rejected: [] })).toBe("");
    expect(duplicateNote({ withdrawn: [], rejected: [] })).toBe("");
  });
});
