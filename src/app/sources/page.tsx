import { AppShell, PageIntro } from "@/components/app-shell";
import { IngestPanel } from "@/components/ingest-panel";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const state = await loadState();

  return (
    <AppShell active="sources">
      <PageIntro kicker="Deep link — ingest also lives on the plan" title="Sources">
        First visit uses the stepper on the plan. After that, new files drop into the inbox on
        the same page. This list is the same demo pack.
      </PageIntro>
      <IngestPanel sources={state.sources} />
    </AppShell>
  );
}
