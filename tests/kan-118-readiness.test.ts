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
  // Two gaps have overlapping review categories; attention must count each once.
  const live = state.gaps.filter(g => !g.retired).slice(0, 2);
  state.gaps = live;
  for (const gap of live) {
    gap.status = "validated_open";
    gap.human_validated = true;
    gap.new_source_at = undefined;
  }
  state.tactics = [];
  live[0].human_validated = false;
  const before = planGates(state);
  const render = () => renderToStaticMarkup(createElement(InventoryReadiness, {
    cards: buildPlanWorkspace(state).review.map((card, index) => ({
      ...card, gap_status: "validated_open" as const, needs_review: index === 0, tactics: [],
    })), readyForPrioritize: gapsReadyForPrioritize(state),
  }));
  const beforeHtml = render();
  expect(beforeHtml).toContain("2 live gaps · 1 gaps needing attention");
  expect(beforeHtml).toContain("0 gaps needing new source review");
  live[0].new_source_at = "2026-10-15T10:00:00Z";
  live[1].new_source_at = "2026-10-15T10:00:00Z";
  const html = render();
  expect(html).toContain("2 live gaps · 2 gaps needing attention");
  expect(html).toContain("1 gaps with unconfirmed evidence assessments");
  expect(html).toContain("1 gaps needing tactic mapping review");
  expect(html).toContain("2 gaps needing new source review");
  expect(html).toContain("Review categories can overlap; each gap counts once in gaps needing attention.");
  expect(html).toContain("Previously unlocked stages remain available for eligible work.");
  expect(planGates(state)).toEqual(before);
});

it("distinguishes completed human review from evidence closure and handles an empty inventory", () => {
  const html = renderToStaticMarkup(createElement(InventoryReadiness, { cards: [], readyForPrioritize: false }));
  expect(html).toContain("No live gaps yet.");
  expect(html).toContain("Human review does not mean evidence gaps are addressed.");
});
