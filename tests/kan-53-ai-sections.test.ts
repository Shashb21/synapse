import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "@/modules";
import { runStage } from "@/modules/kernel/run";
import {
  AiDisabledError,
  aiSectionEnabled,
  aiSections,
  aiState,
  setAiEnabled,
  setAiSection,
  storedAiSections,
} from "@/modules/kernel/ai-switch";
import { AI_SECTIONS, AI_SECTION_IDS, noAiSections, sectionOfStage } from "@/modules/kernel/ai-sections";
import { POST as workspaceAiPost } from "@/app/api/workspaces/[id]/ai/route";

const ACTOR = { name: "Sections Test", function: "medical_affairs" as const };

async function allOn() {
  await setAiEnabled({ enabled: true, actor_name: ACTOR.name });
  for (const section of AI_SECTION_IDS) await setAiSection({ section, enabled: true, actor_name: ACTOR.name });
}

describe("AI per section, set by the admin for every customer (KAN-53)", () => {
  beforeAll(allOn);
  afterAll(allOn);

  it("lists every AI use case, with gap status marked as not built", () => {
    expect(AI_SECTIONS.map((section) => section.id)).toEqual([
      "ingestion",
      "gap_extraction",
      "tactic_extraction",
      "mapping",
      "gap_status",
      "partial_split",
      "prioritization",
      "ideation",
    ]);
    expect(AI_SECTIONS.find((section) => section.id === "gap_status")!.built).toBe(false);
    expect(sectionOfStage("S9")).toBe("ideation");
    expect(sectionOfStage("S1")).toBe("ingestion");
    expect(sectionOfStage("S10")).toBeNull();
    expect(Object.values(noAiSections()).every((on) => on === false)).toBe(true);
  });

  it("turning one section off leaves the others on", async () => {
    await setAiSection({ section: "ideation", enabled: false, actor_name: ACTOR.name });
    const sections = await aiSections();
    expect(sections.ideation).toBe(false);
    expect(sections.prioritization).toBe(true);
    expect(await aiSectionEnabled("mapping")).toBe(true);
    expect((await aiState()).enabled).toBe(true);
    expect((await storedAiSections()).updated_by).toBe(ACTOR.name);
  });

  it("an AI stage whose section is off is refused before it runs", async () => {
    await setAiSection({ section: "ideation", enabled: false, actor_name: ACTOR.name });
    await expect(runStage({ stage: "S9", input: {}, actor: ACTOR, role: "medical_affairs" })).rejects.toBeInstanceOf(
      AiDisabledError,
    );
  });

  it("the master switch turns every section off", async () => {
    await allOn();
    await setAiEnabled({ enabled: false, actor_name: ACTOR.name });
    const sections = await aiSections();
    expect(AI_SECTION_IDS.every((id) => sections[id] === false)).toBe(true);
    expect((await aiState()).enabled).toBe(false);
    await allOn();
  });

  it("customers cannot change AI: the workspace AI endpoint refuses", async () => {
    const res = await workspaceAiPost();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Synapse administrator/);
  });
});
