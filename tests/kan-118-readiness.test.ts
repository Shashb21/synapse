import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryReadiness } from "@/components/inventory-readiness";
import { buildSeed } from "@/lib/iegp/seed";
import { buildPlanWorkspace, gapsReadyForPrioritize, planGates } from "@/lib/iegp/engine";

it("updates review counts after new unresolved evidence without relocking eligible stages", () => {
  const state = buildSeed();
  state.asset.wizard_complete = true;
  state.asset.tactics_unlocked = true;
  const before = planGates(state);
  const gap = state.gaps.find(g => !g.retired && g.status === "validated_open")!;
  gap.human_validated = false;
  gap.new_source_at = "2026-10-15T10:00:00Z";
  const cards = buildPlanWorkspace(state).review;
  const html = renderToStaticMarkup(createElement(InventoryReadiness, { cards, readyForPrioritize: gapsReadyForPrioritize(state) }));
  expect(html).toContain("Inventory review readiness");
  expect(html).toContain(`${cards.length} live gaps`);
  expect(html).toContain("gaps needing attention");
  expect(html).toContain("new source review");
  expect(html).toContain("Previously unlocked stages remain available for eligible work.");
  expect(planGates(state)).toEqual(before);
});

it("distinguishes completed human review from evidence closure and handles an empty inventory", () => {
  const html = renderToStaticMarkup(createElement(InventoryReadiness, { cards: [], readyForPrioritize: false }));
  expect(html).toContain("No live gaps yet.");
  expect(html).toContain("Human review does not mean evidence gaps are addressed.");
});
