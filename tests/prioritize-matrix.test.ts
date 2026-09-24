import { beforeAll, describe, expect, it } from "vitest";
import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform } from "@/modules/kernel/db";
import { displayedGapStatus, gapInSetting, isLiveGap, settingOptions } from "@/lib/iegp/engine";
import { createGap, loadState, normalizeSettings, resetSeed, setGapSettings } from "@/lib/iegp/store";
import {
  ALL_SETTINGS_SCOPE,
  DEFAULT_AXES,
  loadScopeAxes,
  saveScopeAxes,
} from "@/modules/stages/s8-prioritization/axes";
import {
  favourability,
  quadrantBand,
  scoreFromFavourability,
} from "@/modules/stages/s8-prioritization/axis-math";
import {
  listPlacements,
  movePlacement,
  validatePlacement,
  type PrioritizationOutput,
} from "@/modules/stages/s8-prioritization/module";

const ACTOR = { name: "Matrix Test", function: "medical_affairs" as const };
const axis = (id: string) => DEFAULT_AXES.axes.find((row) => row.id === id)!;

describe("matrix geometry", () => {
  const impact = axis("decision_impact");
  const effort = axis("effort_cost");

  it("puts favourable-on-both top-left as High, neither as Low, the rest Medium", () => {
    const band = (y: number, x: number) =>
      quadrantBand({ xAxis: impact, yAxis: axis("time_pressure"), scores: { decision_impact: x, time_pressure: y } });
    expect(band(80, 80)).toBe("high");
    expect(band(20, 20)).toBe("low");
    expect(band(80, 20)).toBe("medium");
    expect(band(20, 80)).toBe("medium");
  });

  it("flips a cost-style axis so low effort is the favourable end", () => {
    expect(favourability(effort, 10)).toBe(90);
    expect(scoreFromFavourability(effort, 90)).toBe(10);
    expect(quadrantBand({ xAxis: effort, yAxis: impact, scores: { effort_cost: 10, decision_impact: 90 } })).toBe(
      "high",
    );
    expect(quadrantBand({ xAxis: effort, yAxis: impact, scores: { effort_cost: 90, decision_impact: 10 } })).toBe(
      "low",
    );
  });
});

describe("settings tags", () => {
  it("collapses case and whitespace duplicates, first spelling wins", () => {
    expect(normalizeSettings([" 1L ", "1l", "Perioperative", "perioperative  ", "", 3])).toEqual([
      "1L",
      "Perioperative",
    ]);
  });
});

describe("Prioritize on a setting's matrix", () => {
  let openIds: string[] = [];

  beforeAll(async () => {
    await resetSeed();
    await wipePlatform();
    for (const statement of [
      "No head-to-head comparative effectiveness versus standard of care for the HTA submission.",
      "Real-world quality of life data in elderly patients is missing.",
    ]) {
      await createGap({ statement, actor_name: ACTOR.name, actor_function: ACTOR.function });
    }
    const state = await loadState();
    openIds = state.gaps
      .filter((gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open")
      .map((gap) => gap.id);
    expect(openIds.length).toBeGreaterThanOrEqual(2);
    await setGapSettings({ gap_id: openIds[0]!, settings: ["1L", "Perioperative"], actor_name: ACTOR.name, actor_function: ACTOR.function });
    await setGapSettings({ gap_id: openIds[1]!, settings: ["1l"], actor_name: ACTOR.name, actor_function: ACTOR.function });
  }, 60_000);

  it("scopes gaps by setting tag, case-insensitively", async () => {
    const state = await loadState();
    const first = state.gaps.find((gap) => gap.id === openIds[0])!;
    expect(first.settings).toEqual(["1L", "Perioperative"]);
    expect(settingOptions(state)).toEqual(expect.arrayContaining(["1L", "Perioperative"]));
    expect(settingOptions(state).filter((tag) => tag.toLowerCase() === "1l")).toHaveLength(1);
    const inOneL = state.gaps.filter((gap) => gapInSetting(gap, "1L")).map((gap) => gap.id);
    expect(inOneL).toEqual(expect.arrayContaining([openIds[0], openIds[1]]));
    expect(gapInSetting(first, ALL_SETTINGS_SCOPE)).toBe(true);
  });

  it("remembers each setting's axes and refuses the same axis twice", async () => {
    await saveScopeAxes({ scope: "1L", x_axis: "effort_cost", y_axis: "decision_impact", actor_name: ACTOR.name });
    expect(await loadScopeAxes("1l")).toMatchObject({ x_axis: "effort_cost", y_axis: "decision_impact" });
    expect(await loadScopeAxes("Perioperative")).toBeNull();
    await expect(
      saveScopeAxes({ scope: "1L", x_axis: "effort_cost", y_axis: "effort_cost", actor_name: ACTOR.name }),
    ).rejects.toThrow(/different axes/);
  });

  it("scores only the two chosen axes and bands each gap by its quadrant", async () => {
    const result = await runStage<PrioritizationOutput>({
      stage: "S8",
      input: { gap_ids: openIds.slice(0, 2), x_axis: "effort_cost", y_axis: "decision_impact", setting: "1L" },
      actor: ACTOR,
      role: "medical_affairs",
    });
    expect(result.output.axes.map((row) => row.id)).toEqual(["effort_cost", "decision_impact"]);
    expect(result.output.placements).toHaveLength(2);
    const placements = await listPlacements();
    for (const id of openIds.slice(0, 2)) {
      const placement = placements.find((row) => row.gap_id === id)!;
      expect(Object.keys(placement.axis_scores).sort()).toEqual(["decision_impact", "effort_cost"]);
      expect(placement.band).toBe(
        quadrantBand({ xAxis: axis("effort_cost"), yAxis: axis("decision_impact"), scores: placement.axis_scores }),
      );
      expect(placement.validated).toBe(false);
    }
  }, 60_000);

  it("drag moves the band; a validated gap stays validated inside its quadrant only", async () => {
    const gapId = openIds[0]!;
    const drag = (x: number, y: number) =>
      movePlacement({ gap_id: gapId, x_axis: "effort_cost", y_axis: "decision_impact", x, y, actor: ACTOR });

    const topLeft = await drag(85, 85);
    expect(topLeft.band).toBe("high");
    // Favourable X on a cost axis is low effort.
    expect(topLeft.axis_scores.effort_cost).toBe(15);

    await validatePlacement({ gap_id: gapId, band: "high", rationale: "Blocks the 1L HTA dossier", actor: ACTOR });
    const nudge = await drag(70, 90);
    expect(nudge.validated).toBe(true);
    expect(nudge.band).toBe("high");

    const bottomRight = await drag(10, 10);
    expect(bottomRight.band).toBe("low");
    expect(bottomRight.validated).toBe(false);
  });

  it("a first placement run leaves already-placed gaps where the user put them", async () => {
    const before = (await listPlacements()).find((row) => row.gap_id === openIds[0])!;
    await runStage({
      stage: "S8",
      input: { gap_ids: openIds.slice(0, 2), x_axis: "effort_cost", y_axis: "decision_impact", only_missing: true },
      actor: ACTOR,
      role: "medical_affairs",
    });
    const after = (await listPlacements()).find((row) => row.gap_id === openIds[0])!;
    expect(after.axis_scores).toEqual(before.axis_scores);
    expect(after.band).toBe("low");
  }, 60_000);

  it("a validated gap placed on new axes gains a position but keeps its band", async () => {
    const gapId = openIds[1]!;
    await validatePlacement({ gap_id: gapId, band: "medium", rationale: "Relevant, not this cycle", actor: ACTOR });
    await runStage({
      stage: "S8",
      input: { gap_ids: [gapId], x_axis: "patient_impact", y_axis: "payer_value" },
      actor: ACTOR,
      role: "medical_affairs",
    });
    const placement = (await listPlacements()).find((row) => row.gap_id === gapId)!;
    expect(typeof placement.axis_scores.patient_impact).toBe("number");
    expect(typeof placement.axis_scores.payer_value).toBe("number");
    expect(placement.validated).toBe(true);
    expect(placement.band).toBe("medium");
  }, 60_000);

  it("a gap split or rewritten from a tagged parent keeps the parent's settings", async () => {
    const child = await createGap({
      statement: "Leftover open slice of the tagged gap.",
      actor_name: ACTOR.name,
      actor_function: ACTOR.function,
      parent_gap_id: openIds[0]!,
    });
    const state = await loadState();
    expect(state.gaps.find((gap) => gap.id === child)!.settings).toEqual(["1L", "Perioperative"]);
  });
});
