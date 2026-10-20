import { describe, expect, it } from "vitest";
import { compareGapNumbers } from "@/lib/iegp/gap-number";

const cards = [
  { gap_id: "a", number: 1000 },
  { gap_id: "z", number: 2 },
  { gap_id: "b", number: 10 },
  { gap_id: "c", number: 2 },
  { gap_id: "missing-z", number: null },
  { gap_id: "missing-a", number: undefined },
  { gap_id: "missing-0", number: 0 },
];
describe("KAN-119 displayed gap number sorting", () => {
  it.each([
    ["asc", ["c", "z", "b", "a", "missing-0", "missing-a", "missing-z"]],
    ["desc", ["a", "b", "c", "z", "missing-0", "missing-a", "missing-z"]],
  ] as const)("sorts %s numerically with missing numbers last and ID-ascending ties", (direction, expected) => {
    expect([...cards].sort((a, b) => compareGapNumbers(a, b, direction)).map(card => card.gap_id)).toEqual(expected);
    expect([...cards].reverse().sort((a, b) => compareGapNumbers(a, b, direction)).map(card => card.gap_id)).toEqual(expected);
  });
});
