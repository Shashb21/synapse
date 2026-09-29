import { beforeAll, describe, expect, it } from "vitest";
import "@/modules";
import { wipePlatform } from "@/modules/kernel/db";
import {
  createGap,
  loadState,
  normalizeGapMetadata,
  resetDemoSetup,
  setGapMetadata,
} from "@/lib/iegp/store";

const ACTOR = { actor_name: "Metadata Test", actor_function: "medical_affairs" as const };

describe("gap metadata (KAN-49)", () => {
  let gapId = "";

  beforeAll(async () => {
    await resetDemoSetup();
    await wipePlatform();
    await createGap({ statement: "No real-world persistence data in German routine care.", ...ACTOR });
    gapId = (await loadState()).gaps.at(-1)!.id;
  }, 60_000);

  it("starts empty and cleans what it stores", async () => {
    expect((await loadState()).gaps.find((g) => g.id === gapId)!.metadata).toEqual({
      stakeholders: [],
      geography: "",
      regional_nuances: "",
      notes: "",
    });
    expect(normalizeGapMetadata({ stakeholders: [" Payers ", "payers", "", 7, "HTA"], geography: 42 })).toEqual({
      stakeholders: ["Payers", "HTA"],
      geography: "",
      regional_nuances: "",
      notes: "",
    });
    expect(normalizeGapMetadata(null).stakeholders).toEqual([]);
  });

  it("saves stakeholders, geography, regional nuances and notes, and audits the change", async () => {
    const saved = await setGapMetadata({
      gap_id: gapId,
      metadata: { stakeholders: ["Payers", "G-BA"], geography: "DE", regional_nuances: "AMNOG dossier due Q3", notes: "Ask HEOR" },
      ...ACTOR,
    });
    expect(saved.stakeholders).toEqual(["Payers", "G-BA"]);
    const state = await loadState();
    expect(state.gaps.find((g) => g.id === gapId)!.metadata).toEqual(saved);
    const entry = state.audit.filter((row) => row.entity_id === gapId && row.action === "set_metadata").at(-1);
    expect(entry?.detail).toMatch(/Stakeholders: Payers, G-BA · Geography: DE/);
  });

  it("a split or rewritten child keeps the parent's metadata", async () => {
    await createGap({ statement: "Leftover: persistence beyond 12 months.", parent_gap_id: gapId, ...ACTOR });
    const state = await loadState();
    const child = state.gaps.find((g) => g.parent_gap_id === gapId)!;
    expect(child.metadata.geography).toBe("DE");
    expect(child.metadata.stakeholders).toEqual(["Payers", "G-BA"]);
  });

  it("refuses an unknown gap", async () => {
    await expect(setGapMetadata({ gap_id: "GAP-NOPE", metadata: {}, ...ACTOR })).rejects.toThrow(/not found/);
  });
});
