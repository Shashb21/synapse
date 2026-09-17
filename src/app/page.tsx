import Link from "next/link";
import { AppShell, PageIntro } from "@/components/app-shell";
import {
  CoverageBadge,
  GapBadge,
  PriorityBadge,
  StaleFlag,
  TacticBadge,
} from "@/components/iegp-badges";
import { loadState } from "@/lib/iegp/store";
import { LockForm } from "@/components/lock-form";
import { buildPlanBoard, type PlanColumn, type PlanGapCard } from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

const COLUMNS: { id: PlanColumn; title: string; hint: string }[] = [
  { id: "high", title: "High", hint: "Critical and high locked bands" },
  { id: "medium", title: "Medium", hint: "Decision-relevant, not this cycle's blocker" },
  { id: "low", title: "Low", hint: "Keep on the inventory; do not staff first" },
];

export default async function PlanPage() {
  const state = await loadState();
  const board = buildPlanBoard(state);
  const stale = state.coverages.some((c) => c.stale);

  return (
    <AppShell active="plan">
      <PageIntro kicker={state.asset.inn} title={`${state.asset.name} IEGP`}>
        {state.asset.indication} · {state.asset.geography}. Prioritized gaps and the tactics
        mapped to them. Coverage is not priority — a partial HTA residual can still sit in High.
      </PageIntro>

      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => (
          <section
            key={col.id}
            className="border border-border bg-card/40 p-3"
            aria-labelledby={`plan-${col.id}`}
          >
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 id={`plan-${col.id}`} className="text-[15px] font-medium text-foreground">
                {col.title}
              </h2>
              <span className="text-[11px] text-muted-foreground">
                {board[col.id].length}
              </span>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground">{col.hint}</p>
            <div className="grid gap-3">
              {board[col.id].length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No gaps in this band.</p>
              ) : (
                board[col.id].map((card) => (
                  <GapPlanCard key={card.gap_id} card={card} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <LockForm label="Reset Velmara seed" action="reset" />
        {stale ? <StaleFlag stale /> : null}
      </div>
    </AppShell>
  );
}

function GapPlanCard({ card }: { card: PlanGapCard }) {
  return (
    <article className="border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityBadge band={card.band} />
        <GapBadge status={card.gap_status} />
      </div>
      <Link
        href={`/gaps/${card.gap_id}`}
        className="mt-2 block text-[13px] font-medium text-foreground no-underline hover:underline"
      >
        {card.gap_name}
      </Link>
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{card.residual}</p>
      <h3 className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground">
        Tactics
      </h3>
      {card.tactics.length === 0 ? (
        <p className="mt-1 text-[12px] text-muted-foreground">
          No tactic mapped.{" "}
          <Link href="/tactics" className="text-foreground">
            Propose one
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-1 grid gap-1.5">
          {card.tactics.map((tactic) => (
            <li key={tactic.id}>
              <Link
                href={`/tactics/${tactic.id}`}
                className="flex flex-wrap items-center gap-1.5 text-[12px] text-foreground no-underline hover:underline"
              >
                <span>{tactic.name}</span>
                <TacticBadge status={tactic.status} />
                {tactic.overall ? <CoverageBadge overall={tactic.overall} /> : null}
                {tactic.stale ? <StaleFlag stale /> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
