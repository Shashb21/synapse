import { requireDisposableDatabase } from "./disposable-database";
import "../../src/modules";
import { prioritizationModule } from "../../src/modules/stages/s8-prioritization/module";
import { withWorkspace } from "../../src/modules/workspaces/store";
import type { ModuleContext } from "../../src/modules/kernel/contracts";

/** Real S8 generation and storage, with the provider completion boundary scripted. No paid calls. */
async function generate(workspaceId: string, gapId: string) {
  const ctx: ModuleContext = {
    ai: true, workspace_id: workspaceId, actor: { name: "Scripted model", function: "medical_affairs" }, role: "medical_affairs",
    route: { stage: "S8", provider_id: "anthropic-claude", provider_label: "Scripted", model: "scripted", connected: true, auth: "api_key", params: { temperature: 0, max_tokens: 4096 }, fallbacks: [], degraded: false, reason: null },
    run: { id: "kan132-browser-fixture", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
    complete: async ({ purpose, user }) => {
      const body = JSON.parse(user);
      if (purpose === "priority-critic") return { reviews: body.placements.map((row: { gap_id: string }) => ({ gap_id: row.gap_id, verdict: "keep", confidence: 99, note: "The supplied comparison affects the committee decision" })) };
      return { gaps: body.gaps.map((gap: { id: string; references: { entity_type: string; entity_id: string }[] }) => ({ gap_id: gap.id, scores: { decision_impact: 80, time_pressure: 75 }, rationale: "The missing comparison affects the committee submission", references: gap.references.filter(ref => ref.entity_type === "gap" || ref.entity_type === "objective").map(ref => ({ entity_type: ref.entity_type, entity_id: ref.entity_id, reason: "This supplied record explains the committee evidence need" })) })) };
    },
  };
  await withWorkspace(workspaceId, () => prioritizationModule.run(prioritizationModule.inputSchema.parse({ gap_ids: [gapId], x_axis: "decision_impact", y_axis: "time_pressure" }), ctx));
}

// A separate tsx process gives the application its normal alias resolution and closes all DB pools on exit.
requireDisposableDatabase(process.env.DATABASE_URL);
generate(process.argv[2]!, process.argv[3]!).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
