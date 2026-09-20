import { AppShell, PageIntro } from "@/components/app-shell";
import { ExtractWorkbench } from "@/components/extract-workbench";
import { listExtractRuns } from "@/lib/iegp/extract/store";

export const dynamic = "force-dynamic";

export default async function ExtractRunsPage() {
  const runs = await listExtractRuns(80);
  return (
    <AppShell active="extract-runs">
      <PageIntro kicker="Independent tester" title="Gap extract runs">
        Proposer, critic, and judge on already-parsed markdown or JSON. Dry-run by default. Persist
        writes live Open gaps. Human wording / not-a-gap edits feed gold and hill-climb the prompts.
      </PageIntro>
      <ExtractWorkbench
        initialRuns={runs.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          title: r.title,
          created_at: r.created_at,
          persist: r.persist,
          prompt_version: r.prompt_version,
          error: r.error,
        }))}
      />
    </AppShell>
  );
}
