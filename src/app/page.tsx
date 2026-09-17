import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import { GapBadge, PriorityBadge, StaleFlag } from "@/components/iegp-badges";
import { loadState } from "@/lib/iegp/store";
import { LockForm } from "@/components/lock-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const state = await loadState();
  const candidateNeeds = state.needs.filter((n) => n.status === "candidate").length;
  const stale = state.coverages.filter((c) => c.stale).length;
  const byStatus = Object.fromEntries(
    ["candidate", "validated_open", "validated_partial", "validated_addressed", "excluded"].map(
      (s) => [s, state.gaps.filter((g) => g.status === s).length],
    ),
  );
  const ranked = state.priorities
    .slice()
    .sort((a, b) => b.suggested_score - a.suggested_score);

  return (
    <AppShell active="plan">
      <PageIntro kicker={state.asset.inn} title={`${state.asset.name} integrated evidence plan`}>
        {state.asset.indication} · {state.asset.geography}. Living plan. Coverage is not
        priority. Residuals do not overwrite parent gaps. Every gate is a human lock.
      </PageIntro>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Objectives" value={state.objectives.length} href="/" />
        <Stat label="Candidate needs" value={candidateNeeds} href="/needs" />
        <Stat label="Open / partial gaps" value={(byStatus.validated_open ?? 0) + (byStatus.validated_partial ?? 0)} href="/gaps" />
        <Stat label="Stale mappings" value={stale} href="/gaps" />
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Gap inventory</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-[13px]">
            {state.gaps.map((g) => (
              <Link key={g.id} href={`/gaps/${g.id}`} className="flex items-start justify-between gap-3 no-underline">
                <span className="text-foreground">{g.name}</span>
                <GapBadge status={g.status} />
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Residual priority (locked bands)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-[13px]">
            {ranked.map((p) => {
              const residual = state.residuals.find((r) => r.id === p.residual_id);
              return (
                <Link key={p.id} href="/residuals" className="grid gap-1 no-underline">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{residual?.statement.slice(0, 90)}…</span>
                    <PriorityBadge band={p.band} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Suggested {p.suggested_score} / {p.suggested_band}
                    {p.override_reason ? ` · override: ${p.override_reason}` : ""}
                  </p>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Strategic objectives</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {state.objectives.map((o) => (
            <div key={o.id} className="border border-border p-3">
              <p className="text-[13px] text-foreground">{o.name}</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {o.key_decision} · {o.decision_date} · importance {o.strategic_importance}/5
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <LockForm label="Reset Velmara seed" action="reset" />
        {stale > 0 ? <StaleFlag stale /> : null}
        <p className="text-[12px] text-muted-foreground">
          Registry TAC-REG maps to sequencing, HCRU and QoL — one tactic, several gaps. Elderly
          chart review is Partial because the comparator is missing.
        </p>
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link href={href} className="border border-border bg-card p-4 no-underline">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl text-foreground">{value}</p>
    </Link>
  );
}
