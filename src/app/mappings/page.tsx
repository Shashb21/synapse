import { AppShell, PageIntro } from "@/components/app-shell";
import { MappingTableWorkbench } from "@/components/mapping-table-workbench";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { buildMappingTableView, latestS4MappingRows } from "@/lib/iegp/mapping-table";
import { loadState } from "@/lib/iegp/store";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";

export default async function MappingsPage() {
  const [state, proposed, ai] = await Promise.all([
    loadState(),
    latestS4MappingRows(),
    aiEnabled().catch(() => true),
  ]);
  const workspace = buildPlanWorkspace(state);
  const rows = buildMappingTableView(state, proposed, { ai });

  return (
    <AppShell active="mappings">
      <PageIntro kicker={ai ? "S4 · human in the loop" : "AI is off · map by hand"} title="Gap ↔ tactic mapping table">
        One row per gap: assigned tactic(s) and mapping status (open, addressed, partially addressed).
        {ai
          ? " Accept, reject or edit any row with a short rationale. A row you save wins over later S4 runs, and a tactic you remove or reject is never mapped again by S4. Those notes feed the S4 mapping prompt on the next run."
          : " Pick the tactics and a status for each row and save it with a short rationale."}
      </PageIntro>
      <MappingTableWorkbench rows={rows} tactics={workspace.availableTactics} />
    </AppShell>
  );
}
