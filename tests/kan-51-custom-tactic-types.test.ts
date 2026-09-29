import { beforeAll, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import { createProposedTactic, loadState, modifyTactic, resetDemoSetup } from "@/lib/iegp/store";
import { customTypesInUse, normalizeCustomType, readCustomType } from "@/lib/iegp/custom-tactic-type";
import { tacticColor, tacticTypeLabel } from "@/lib/iegp/tactic-type-colors";

const ACTOR = { actor_name: "Custom Type Test", actor_function: "medical_affairs" as const };

async function create(name: string, custom_type: { label: string; color: string } | null) {
  return createProposedTactic({
    name,
    type: "rwe_study",
    description: name,
    evidence_question: `Does ${name} answer the gap?`,
    population: "",
    intervention: "",
    comparator: "",
    outcomes: "",
    owner: "",
    function: "medical_affairs",
    residual_ids: [],
    custom_type,
    ...ACTOR,
  });
}

describe("custom tactic types (KAN-51)", () => {
  beforeAll(async () => {
    await resetDemoSetup();
    await wipePlatform();
  }, 60_000);

  it("cleans a name and refuses a bad colour or an over-long name", () => {
    expect(normalizeCustomType({ label: "  Patient  advisory ", color: "#BE185D" })).toEqual({
      label: "Patient advisory",
      color: "#be185d",
    });
    expect(normalizeCustomType({ label: " ", color: "#be185d" })).toBeNull();
    expect(() => normalizeCustomType({ label: "Advisory", color: "pink" })).toThrow(/hex colour/);
    expect(() => normalizeCustomType({ label: "x".repeat(41), color: "#be185d" })).toThrow(/at most 40/);
    expect(readCustomType({ label: "Advisory", color: "pink" })).toBeNull();
  });

  it("shows the custom name and colour but keeps the standard type underneath", async () => {
    const id = await create("Caregiver advisory board", { label: "Advisory board", color: "#be185d" });
    const tactic = (await loadState()).tactics.find((row) => row.id === id)!;
    expect(tactic.type).toBe("rwe_study");
    expect(tactic.custom_type).toEqual({ label: "Advisory board", color: "#be185d" });
    expect(tacticTypeLabel(tactic)).toBe("Advisory board");
    expect(tacticColor(tactic)).toBe("#be185d");
    expect(tacticTypeLabel({ type: "rwe_study", custom_type: null })).toBe("RWE study");
  });

  it("one name keeps one colour: reusing a name recolours the others", async () => {
    await create("Oncologist advisory board", { label: "advisory board", color: "#0369a1" });
    const state = await loadState();
    const boards = state.tactics.filter((row) => row.custom_type?.label.toLowerCase() === "advisory board");
    expect(boards).toHaveLength(2);
    expect(new Set(boards.map((row) => row.custom_type!.color))).toEqual(new Set(["#0369a1"]));
    expect(customTypesInUse(state.tactics).filter((row) => row.label.toLowerCase() === "advisory board")).toHaveLength(1);
  });

  it("an edit sets or clears the custom type and files the change", async () => {
    const id = await create("Plain RWE", null);
    await modifyTactic({
      tactic_id: id,
      custom_type: { label: "Registry extension", color: "#047857" },
      rationale: "Named as the team calls it",
      ...ACTOR,
    });
    expect((await loadState()).tactics.find((row) => row.id === id)!.custom_type?.label).toBe("Registry extension");
    await modifyTactic({ tactic_id: id, custom_type: null, rationale: "Back to the standard type", ...ACTOR });
    expect((await loadState()).tactics.find((row) => row.id === id)!.custom_type).toBeNull();
    await expect(
      modifyTactic({ tactic_id: id, custom_type: null, rationale: "No change at all", ...ACTOR }),
    ).rejects.toThrow(/Nothing changed/);
  });
});
