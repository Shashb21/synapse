import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { GapBadge } from "@/components/iegp-badges";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import { displayedGapStatus } from "@/lib/iegp/engine";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function GapsPage() {
  const state = await loadState();
  return (
    <AppShell active="gaps">
      <PageIntro kicker="Decision objects" title="Evidence gaps">
        Gaps are named decision objects. Many candidate needs can join onto one gap.
        Status is computed Open / Partially Addressed / Addressed from joined tactics and published
        literature. Click Open or Addressed to override with a reason. Click Partial to split or rewrite.
      </PageIntro>
      {state.gaps.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No gaps yet. Ingest a source on Upload — extracted gaps land here already mapped.
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
              className="border border-border bg-card p-4 no-underline"
            >
              <div className="flex flex-wrap items-center gap-2">
                <GapBadge status={displayedGapStatus(g)} />
                <span className="text-[12px] text-muted-foreground">
                  {DOMAIN_LABELS[g.domain]}
                </span>
              </div>
              <p className="mt-2 text-[13px] leading-5 text-foreground">{g.name}</p>
              <p className="mt-2 text-[12px] text-muted-foreground">
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
