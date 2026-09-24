import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { IngestPanel } from "@/components/ingest-panel";
import { loadState } from "@/lib/iegp/store";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const state = await loadState();
  const ai = await aiEnabled().catch(() => true);
  const blockCount = new Map<string, number>();
  for (const block of state.blocks) blockCount.set(block.source_id, (blockCount.get(block.source_id) ?? 0) + 1);

  return (
    <AppShell active="sources">
      {ai ? (
        <>
          <PageIntro kicker="Deep link — ingest also lives on the plan" title="Sources">
            First visit uses the stepper on the plan. After that, new files ingest on the Upload
            place. This list is the same demo pack.
          </PageIntro>
          <IngestPanel sources={state.sources} />
        </>
      ) : (
        <PageIntro kicker="AI is off · read only" title="Sources">
          Nothing is uploaded or parsed while AI is off. Sources already here stay readable. Add
          gaps and tactics by hand on{" "}
          <Link href="/?place=upload" className="text-foreground">
            Start
          </Link>
          .
        </PageIntro>
      )}

      <section className="mt-4 border border-border bg-card/40 p-3" aria-labelledby="source-blocks">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="source-blocks" className="text-[13px] font-medium text-foreground">
            Source blocks
          </h2>
          {ai ? (
            <Link href="/sources/new" className="text-[12px] underline-offset-2 hover:underline">
              Type a source by hand (no AI)
            </Link>
          ) : null}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {ai
            ? "Review, edit, split, merge, delete or add blocks, restore text the model dropped, and set each source's stakeholder function. Human edits survive every re-parse."
            : "Open a source to read its blocks. No new sources are added while AI is off."}
        </p>
        {state.sources.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">No sources yet.</p>
        ) : (
          <ul className="mt-2 grid gap-1 text-[12px]">
            {state.sources.map((source) => (
              <li key={source.id}>
                <Link href={`/sources/${encodeURIComponent(source.id)}`} className="underline-offset-2 hover:underline">
                  {source.id} · {source.title}
                </Link>{" "}
                <span className="text-[11px] text-muted-foreground">
                  {blockCount.get(source.id) ?? 0} block(s) · {source.stakeholder_function}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
