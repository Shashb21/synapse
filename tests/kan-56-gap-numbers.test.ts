import { describe, expect, it } from "vitest";
import { createGap, gapNumberLabel, loadState, resetDemoSetup } from "@/lib/iegp/store";

// Owner feedback (KAN-56): gaps are shown by a plain number like 001, not by their id.
describe("gap numbers", () => {
  it("pads to three digits and shows a dash when there is none", () => {
    expect(gapNumberLabel(1)).toBe("001");
    expect(gapNumberLabel(42)).toBe("042");
    expect(gapNumberLabel(1234)).toBe("1234");
    expect(gapNumberLabel(0)).toBe("—");
  });

  it("numbers every gap once, uniquely, and gives a new gap the next number", async () => {
    await resetDemoSetup();
    const before = await loadState();
    const numbers = before.gaps.map((gap) => gap.number);
    expect(numbers.every((n) => n > 0)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);

    const make = (name: string) =>
      createGap({ name, statement: `No evidence on ${name}.`, actor_name: "A. Rao", actor_function: "heor" });
    const first = await make("Numbered gap one");
    const second = await make("Numbered gap two");
    const after = await loadState();
    const numberOf = (id: string) => after.gaps.find((gap) => gap.id === id)!.number;
    expect(numberOf(first)).toBe(Math.max(0, ...numbers) + 1);
    expect(numberOf(second)).toBe(numberOf(first) + 1);
    // Loading again does not renumber anything.
    const again = await loadState();
    expect(again.gaps.map((gap) => [gap.id, gap.number])).toEqual(after.gaps.map((gap) => [gap.id, gap.number]));
  });
});
