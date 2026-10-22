/** Truthful Prioritize recovery without invoking database-backed loaders. */
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PrioritizePlace } from "@/components/prioritize/prioritize-place";
import { buildSeed } from "@/lib/iegp/seed";

vi.mock("@/modules/stages/s8-prioritization/module", () => ({listPlacements: async () => []}));
vi.mock("@/modules/stages/s8-prioritization/axes", () => ({ALL_SETTINGS_SCOPE: "all", loadAxes: async () => ({axes: []}), loadScopeAxes: async () => null}));
vi.mock("@/modules/auth/session", () => ({sessionContext: async () => ({signed_in: true, actor: {name: "Reviewer", function: "medical_affairs"}, role: "medical_affairs"})}));

it.each([false, true])("offers inventory recovery for zero Open gaps, preserving unlocked=%s", async unlocked => {
  const state = buildSeed(); state.gaps = []; state.asset.tactics_unlocked = unlocked;
  const html = renderToStaticMarkup(await PrioritizePlace({state, setting: undefined, addressed: [], availableTactics: []}));
  expect(html).toContain("No Open gaps across the plan");
  expect(html).toContain('href="/?place=gaps"');
  expect(html).not.toContain("Set and validate priority for every Open gap");
  expect(html).not.toContain("Continue to tactics");
  if (unlocked) expect(html).toContain("Tactics is unlocked");
  else expect(html).toContain("Review evidence assessments");
  expect(state.asset.tactics_unlocked).toBe(unlocked);
});
