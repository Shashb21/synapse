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
import {
  buildPlanWorkspace,
  type PlanColumn,
  type PlanGapCard,
  type ReviewGapCard,
  type UnprioritizedGapCard,
} from "@/lib/iegp/engine";
import {
  EXCLUSION_LABELS,
  EXCLUSION_REASONS,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
} from "@/lib/iegp/enums";

export const dynamic = "force-dynamic";

const COLUMNS: { id: PlanColumn; title: string; hint: string }[] = [
  { id: "high", title: "High", hint: "Critical and high — staff these first" },
  { id: "medium", title: "Medium", hint: "Decision-relevant, not this cycle's blocker" },
  { id: "low", title: "Low", hint: "Keep on the inventory; do not staff first" },
];

export default async function PlanPage() {
  const state = await loadState();
  const workspace = buildPlanWorkspace(state);
  const stale = state.coverages.some((c) => c.stale);

  return (
    <AppShell active="plan">
      <PageIntro kicker={state.asset.inn} title={`${state.asset.name} IEGP`}>
        {state.asset.indication} · {state.asset.geography}. Upload sources, extract gaps and
        tactics, draft residuals, then review. You accept, reject, or modify gaps. You lock
        priority — the engine does not. Then create or assign tactics. Addressed gaps stay here
        with the tactics that closed them.
      </PageIntro>

      <ol className="mb-8 grid gap-2 text-[12px] text-muted-foreground sm:grid-cols-5">
        <li className="border border-border bg-card/40 px-3 py-2">1. Ingest sources</li>
        <li className="border border-border bg-card/40 px-3 py-2">2. Review gaps + residuals</li>
        <li className="border border-border bg-card/40 px-3 py-2">3. Human priority</li>
        <li className="border border-border bg-card/40 px-3 py-2">4. Create / assign tactics</li>
        <li className="border border-border bg-card/40 px-3 py-2">5. Addressed stay on the plan</li>
      </ol>

      <section className="mb-10" aria-labelledby="review-gaps">
        <h2 id="review-gaps" className="text-[15px] font-medium text-foreground">
          Open gaps and residual evidence needs
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Extracted candidates. Accept, reject, or modify before anything is prioritized.
        </p>
        {workspace.review.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No extracted gaps waiting for review.{" "}
            <Link href="/sources" className="text-foreground">
              Ingest a source
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-3">
            {workspace.review.map((card) => (
              <ReviewCard key={card.gap_id} card={card} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-10" aria-labelledby="prioritize-gaps">
        <h2 id="prioritize-gaps" className="text-[15px] font-medium text-foreground">
          Prioritize
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Accepted open and partial gaps with a residual, no human-locked band yet. The engine
          does not suggest a score or a band.
        </p>
        {workspace.unprioritized.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            All accepted gaps with residuals have a human-locked priority.
          </p>
        ) : (
          <div className="grid gap-3">
            {workspace.unprioritized.map((card) => (
              <PrioritizeCard key={card.gap_id} card={card} />
            ))}
          </div>
        )}
      </section>

      <h2 className="mb-3 text-[15px] font-medium text-foreground">Prioritized plan</h2>
      <p className="mb-4 text-[12px] text-muted-foreground">
        After the band is locked, create a tactic or assign an existing one. Coverage is not
        priority.
      </p>
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
              <span className="text-[11px] text-muted-foreground">{workspace.board[col.id].length}</span>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground">{col.hint}</p>
            <div className="grid gap-3">
              {workspace.board[col.id].length === 0 ? (
                <p className="text-[12px] text-muted-foreground">No gaps in this band.</p>
              ) : (
                workspace.board[col.id].map((card) => (
                  <GapPlanCard
                    key={card.gap_id}
                    card={card}
                    availableTactics={workspace.availableTactics}
                    canAssign
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>

      <section className="mt-10" aria-labelledby="addressed-gaps">
        <h2 id="addressed-gaps" className="text-[15px] font-medium text-foreground">
          Addressed
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Closed gaps remain on the plan with the tactics that addressed them. The engine never
          writes this status.
        </p>
        {workspace.addressed.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No addressed gaps yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {workspace.addressed.map((card) => (
              <GapPlanCard
                key={card.gap_id}
                card={card}
                availableTactics={workspace.availableTactics}
              />
            ))}
          </div>
        )}
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <LockForm label="Reset Velmara seed" action="reset" />
        {stale ? <StaleFlag stale /> : null}
      </div>
    </AppShell>
  );
}

function ReviewCard({ card }: { card: ReviewGapCard }) {
  return (
    <article className="border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <GapBadge status="candidate" />
      </div>
      <Link
        href={`/gaps/${card.gap_id}`}
        className="mt-2 block text-[13px] font-medium text-foreground no-underline hover:underline"
      >
        {card.gap_name}
      </Link>
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{card.statement}</p>
      <p className="mt-2 text-[12px] leading-5 text-foreground">
        Residual: {card.residual}
      </p>
      {card.needs.length > 0 ? (
        <ul className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
          {card.needs.map((need) => (
            <li key={need.id}>{need.statement}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <LockForm
          label="Accept gap"
          action="lock_gap"
          extra={{ gap_id: card.gap_id, status: "validated_open" }}
          confirmLabel="Accept"
        />
        <LockForm label="Reject gap" action="lock_gap" extra={{ gap_id: card.gap_id, status: "excluded" }} confirmLabel="Reject">
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Reason
            <select
              name="exclusion_reason"
              required
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
              defaultValue="not_defined"
            >
              {EXCLUSION_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {EXCLUSION_LABELS[reason]}
                </option>
              ))}
            </select>
          </label>
        </LockForm>
        <LockForm label="Modify gap" action="modify_gap" extra={{ gap_id: card.gap_id }} confirmLabel="Save">
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Name
            <input
              name="name"
              required
              defaultValue={card.gap_name}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
            />
          </label>
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Statement
            <textarea
              name="statement"
              required
              defaultValue={card.statement}
              className="min-h-20 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground"
            />
          </label>
        </LockForm>
      </div>
    </article>
  );
}

function PrioritizeCard({ card }: { card: UnprioritizedGapCard }) {
  return (
    <article className="border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <GapBadge status={card.gap_status} />
        <span className="text-[11px] text-amber-300">Priority unlocked</span>
      </div>
      <Link
        href={`/gaps/${card.gap_id}`}
        className="mt-2 block text-[13px] font-medium text-foreground no-underline hover:underline"
      >
        {card.gap_name}
      </Link>
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{card.residual}</p>
      <div className="mt-3">
        <LockForm
          label="Set priority"
          action="lock_priority"
          extra={{ residual_id: card.residual_id }}
          confirmLabel="Lock band"
        >
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Band (you choose — no engine suggestion)
            <select
              name="band"
              required
              defaultValue=""
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
            >
              <option value="" disabled>
                Choose High, Medium, or Low
              </option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        </LockForm>
      </div>
    </article>
  );
}

function GapPlanCard({
  card,
  availableTactics,
  canAssign,
}: {
  card: PlanGapCard;
  availableTactics: { id: string; name: string }[];
  canAssign?: boolean;
}) {
  const unmapped = availableTactics.filter((t) => !card.tactics.some((mapped) => mapped.id === t.id));
  return (
    <article className="border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {card.band ? <PriorityBadge band={card.band} /> : null}
        <GapBadge status={card.gap_status} />
      </div>
      <Link
        href={`/gaps/${card.gap_id}`}
        className="mt-2 block text-[13px] font-medium text-foreground no-underline hover:underline"
      >
        {card.gap_name}
      </Link>
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{card.residual}</p>
      <h3 className="mt-3 text-[11px] uppercase tracking-wide text-muted-foreground">Tactics</h3>
      {card.tactics.length === 0 ? (
        <p className="mt-1 text-[12px] text-muted-foreground">No tactic mapped yet.</p>
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
      {canAssign ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {unmapped.length > 0 ? (
            <LockForm
              label="Assign tactic"
              action="assign_tactic"
              extra={{ gap_id: card.gap_id }}
              confirmLabel="Assign"
            >
              <label className="grid gap-1 text-[12px] text-muted-foreground">
                Existing tactic
                <select
                  name="tactic_id"
                  required
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                >
                  {unmapped.map((tactic) => (
                    <option key={tactic.id} value={tactic.id}>
                      {tactic.name}
                    </option>
                  ))}
                </select>
              </label>
            </LockForm>
          ) : null}
          <LockForm
            label="Create tactic"
            action="create_tactic"
            extra={{
              gap_id: card.gap_id,
              residual_ids: card.residual_id ?? "",
            }}
            confirmLabel="Create"
          >
            <input
              name="name"
              required
              placeholder="Tactic name"
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            />
            <select name="type" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
              {TACTIC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TACTIC_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <input
              name="evidence_question"
              required
              placeholder="Evidence question"
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
            />
            <input type="hidden" name="description" value="Proposed from the IEGP plan." />
            <input type="hidden" name="population" value="To be specified" />
            <input type="hidden" name="intervention" value="Velmara" />
            <input type="hidden" name="comparator" value="To be specified" />
            <input type="hidden" name="outcomes" value="To be specified" />
            <input type="hidden" name="geography" value="US + EU5" />
            <input type="hidden" name="owner" value="" />
            <input type="hidden" name="function" value="evidence_lead" />
          </LockForm>
        </div>
      ) : null}
    </article>
  );
}
