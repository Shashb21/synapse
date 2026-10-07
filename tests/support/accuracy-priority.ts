import { expect } from "vitest";
import type { AccuracyModuleContext } from "@/accuracy/kernel/contracts";
import { accuracyTransactionActive } from "@/accuracy/store/db";
const actor = { name: "Priority reviewer", function: "heor" as const };
export function scriptedPriorityContext(f: { workspace_id: string; org_id: string }, scores = { effort_cost: 90, decision_impact: 10 }): AccuracyModuleContext {
  return { workspace_id: f.workspace_id, org_id: f.org_id, actor, role: "heor",
    route: { call_kind: "prioritize", role: "proposer", provider_id: "fixture", provider_label: "Fixture", model: "fixture", auth: "api_key", connected: true,
      params: { temperature: 0, max_tokens: 4096 }, fallbacks: [], degraded: false, reason: null },
    run: { id: "fixture", step: async (_name, fn) => fn(), note: () => {}, steps: () => [], recordAgentEvent: async () => {}, usageSummary: () => ({ token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd: 0 }) },
    noteCost: () => {}, complete: async ({ purpose, user }) => {
      expect(accuracyTransactionActive()).toBe(false);
      const input = JSON.parse(user);
      expect(Object.keys(input.considerations)).toHaveLength(7);
      const raw = purpose === "priority-critic" ? { reviews: input.placements.map((p: { gap_id: string }) => ({ gap_id: p.gap_id, verdict: "keep", confidence: 90, note: "Scores reflect the stated evidence limitations" })) }
        : { gaps: input.gaps.map((g: { id: string }) => ({ gap_id: g.id, scores, rationale: "Comparison missing; limited decision impact and high cost" })) };
      return { raw: JSON.stringify(raw), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    } };
}
