import { describe, expect, it } from "vitest";
import { buildKnowledgeGraph } from "@/lib/graph/connections";
import { buildSeedState } from "@/lib/pipeline";

describe("REQ-GRF knowledge graph", () => {
  it("REQ-GRF-001 surfaces a blend when one CIR sits on two named themes", () => {
    const state = buildSeedState();
    const graph = buildKnowledgeGraph(state);
    expect(graph.multi_theme_insights).toBeGreaterThan(0);
    const blend = graph.revelations.find((r) => r.kind === "blend");
    expect(blend).toBeTruthy();
    expect(blend!.theme_ids.length).toBeGreaterThanOrEqual(2);
    expect(blend!.insight_ids.length).toBeGreaterThanOrEqual(1);
  });

  it("REQ-GRF-002 reveals a bridge or gap-closure that no single deck stated", () => {
    const state = buildSeedState();
    const graph = buildKnowledgeGraph(state);
    const kinds = new Set(graph.revelations.map((r) => r.kind));
    expect(kinds.has("blend")).toBe(true);
    expect(kinds.has("bridge")).toBe(true);
    expect(kinds.has("gap_closure")).toBe(true);
    expect(
      graph.revelations.filter((r) => r.kind === "gap_closure").length,
    ).toBeLessThanOrEqual(5);
    expect(graph.revelations.some((r) => r.insight_ids.length >= 2)).toBe(true);
    expect(graph.theme_bridges.length).toBeGreaterThan(0);
    expect(graph.revelations.some((r) => /^COMMUNITY\b/.test(r.title))).toBe(
      false,
    );
  });
});
