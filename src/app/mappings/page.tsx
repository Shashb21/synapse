import { AppShell, PageIntro } from "@/components/app-shell";
import { MappingTableWorkbench } from "@/components/mapping-table-workbench";
import { buildPlanWorkspace } from "@/lib/iegp/engine";
import { buildMappingTableView, latestS4MappingRows } from "@/lib/iegp/mapping-table";
import { loadState } from "@/lib/iegp/store";
import { listRejectedMappings } from "@/lib/iegp/restore";
import { RejectedMappings } from "@/components/restore-actions";
import { aiSectionEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";

export default async function MappingsPage() {
  const [state, proposed, ai, rejected] = await Promise.all([
    loadState(),
    latestS4MappingRows(),
    aiSectionEnabled("mapping").catch(() => false),
    listRejectedMappings(),
  ]);
  const workspace = buildPlanWorkspace(state);
  const rows = buildMappingTableView(state, proposed, { ai });

  return (
    <AppShell active="mappings">
      <PageIntro kicker={ai ? "AI mapping · you decide" : "Map by hand"} title="Gap ↔ tactic mapping table">
        One row per gap: assigned tactic(s) and mapping status (open, addressed, partially addressed).
        {ai
          ? " Accept, reject or edit any row with a short rationale. A row you save wins over later AI mapping runs, and a tactic you remove or reject is never mapped to that gap again. Your notes guide the next AI mapping run."
          : " Pick the tactics and a status for each row and save it with a short rationale."}
      </PageIntro>
      <MappingTableWorkbench rows={rows} tactics={workspace.availableTactics} />
      <RejectedMappings rows={rejected} />
    </AppShell>
  );
}
