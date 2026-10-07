import { describe, expect, it } from "vitest";
import "@/modules";
import { HarnessNotBuiltError, harnessPartialGaps, harnessSandboxId, runHarness } from "@/modules/harness/harness";
import { setAiSection } from "@/modules/kernel/ai-switch";
import { loadState } from "@/lib/iegp/store";

const ACTOR = { name: "Harness Test", function: "medical_affairs" as const };

describe("admin AI harness (KAN-54)", () => {
  it("gap status says no AI module is developed", async () => {
    await expect(runHarness({ case: "gap_status", input: { mode: "sample" }, actor: ACTOR })).rejects.toBeInstanceOf(
      HarnessNotBuiltError,
    );
  });

  it("runs in its own sandbox, never the workspace in scope", async () => {
    const before = (await loadState()).sources.length;
    const result = await runHarness({ case: "ingestion", input: { mode: "sample", demo_id: "medical-kol" }, actor: ACTOR });
    expect(result.steps.map((step) => step.stage)).toEqual(["S0", "S1"]);
    expect(result.input_summary).toMatch(/Velmara sample/);
    expect(result.route).toMatch(/test stub/);
    expect((await loadState()).sources.length).toBe(before);
    expect(await harnessSandboxId()).toBe(await harnessSandboxId());
  }, 120_000);

  it("extracts gaps from the admin's own pasted text, even with the section off for customers", async () => {
    await setAiSection({ section: "gap_extraction", enabled: false, actor_name: ACTOR.name });
    try {
      const result = await runHarness({
        case: "gap_extraction",
        input: {
          mode: "custom",
          title: "Payer notes",
          text: "Payers need 6-month persistence data in routine US care. Limited evidence on discontinuation.",
        },
        actor: ACTOR,
      });
      expect(result.steps.map((step) => step.stage)).toEqual(["S0", "S1", "S2"]);
      expect(result.input_summary).toMatch(/Your source “Payer notes”/);
    } finally {
      await setAiSection({ section: "gap_extraction", enabled: true, actor_name: ACTOR.name });
    }
  }, 120_000);

  it("maps, prioritizes and ideates on a gap the admin writes", async () => {
    const input = {
      mode: "custom" as const,
      gap_name: "Persistence in German routine care",
      gap_statement: "No real-world persistence data beyond 12 months in German routine care.",
      gap_domain: "adherence" as const,
    };
    for (const [useCase, stage] of [
      ["mapping", "S4"],
      ["prioritization", "S8"],
      ["ideation", "S9"],
    ] as const) {
      const result = await runHarness({ case: useCase, input, actor: ACTOR });
      expect(result.steps.at(-1)!.stage).toBe(stage);
      expect(result.input_summary).toMatch(/Your gap/);
    }
  }, 240_000);

  it("suggests a split for a partially addressed sample gap, and extracts tactics from a sample", async () => {
    const partial = await harnessPartialGaps();
    expect(partial.length).toBeGreaterThan(0);
    const split = await runHarness({ case: "partial_split", input: { mode: "custom", gap_id: partial[0]!.id }, actor: ACTOR });
    expect(split.steps.at(-1)!.stage).toBe("S6");
    const tactics = await runHarness({ case: "tactic_extraction", input: { mode: "sample", demo_id: "cdp" }, actor: ACTOR });
    expect(tactics.steps.at(-1)!.stage).toBe("S3");
  }, 240_000);
});
