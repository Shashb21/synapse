import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { GapBadge, ParkedFlag } from "@/components/iegp-badges";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { displayedGapStatus } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";
import { aiSectionEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";

export default async function GapsPage() {
  const state = await loadState();
  const ai = await aiSectionEnabled("ingestion").catch(() => false);
  return (
    <AppShell active="gaps">
      <PageIntro kicker="Decision objects" title="Evidence Inventory">
        Review evidence status and open a gap to confirm its evidence assessment or review mapped tactics.
        Split or rewrite Partial gaps before prioritization.
      </PageIntro>
      {state.gaps.length === 0 ? (
        <p className="text-callout text-muted-foreground">
          {ai ? (
            "No gaps yet. Ingest a source on Upload — extracted gaps land here already mapped."
          ) : (
            <>
              No gaps yet. Add them on{" "}
              <Link href="/?place=upload" className="text-foreground">
                Start
              </Link>
              .
            </>
          )}
        </p>
      ) : (
      <div className="grid gap-3">
        {state.gaps.map((g) => {
          const needCount = state.need_gap_links.filter((l) => l.gap_id === g.id).length;
          const tacticCount = state.coverages.filter((c) => c.gap_id === g.id).length;
          return (
            <Link
              key={g.id}
              href={`/gaps/${g.id}`}
              className="border border-border bg-card p-4 no-underline rounded-lg"
            >
              <div className="flex flex-wrap items-center gap-2">
                <GapBadge status={displayedGapStatus(g)} />
                {g.parked_at ? <ParkedFlag reason={g.parked_reason} /> : null}
                <span className="text-callout text-muted-foreground">
                  {DOMAIN_LABELS[g.domain]}
                </span>
              </div>
              <p className="mt-2 text-body leading-5 text-foreground">{g.name}</p>
              <p className="mt-2 text-callout text-muted-foreground">
                {needCount} needs · {tacticCount} tactic mappings
                {g.parent_gap_id ? " · leftover of parent" : ""}
              </p>
            </Link>
          );
        })}
      </div>
      )}
    </AppShell>
  );
}
