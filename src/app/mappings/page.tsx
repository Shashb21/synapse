import { AppShell, PageIntro } from "@/components/app-shell";
import { MappingTableWorkbench } from "@/components/mapping-table-workbench";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { buildMappingTableView, latestS4MappingRows } from "@/lib/iegp/mapping-table";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function MappingsPage() {
  const [state, proposed] = await Promise.all([loadState(), latestS4MappingRows()]);
  const workspace = buildPlanWorkspace(state);
  const rows = buildMappingTableView(state, proposed);

  return (
    <AppShell active="mappings">
      <PageIntro kicker="S4 · human in the loop" title="Gap ↔ tactic mapping table">
        One row per gap: assigned tactic(s) and mapping status (open, addressed, partially addressed).
        Accept, reject or edit any row with a short rationale. A row you save wins over later S4 runs, and a tactic you remove or reject is never mapped again by S4. Those notes feed the S4 mapping prompt on the next run.
      </PageIntro>
      <MappingTableWorkbench rows={rows} tactics={workspace.availableTactics} />
    </AppShell>
  );
}
