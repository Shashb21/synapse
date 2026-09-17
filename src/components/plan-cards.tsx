import Link from "next/link";
import {
  CoverageBadge,
  GapBadge,
  PriorityBadge,
  StaleFlag,
  TacticBadge,
  TacticReviewBadge,
} from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import type {
  PlanGapCard,
  PlanTactic,
  ReviewGapCard,
  ReviewTacticCard,
  UnprioritizedGapCard,
} from "@/lib/iegp/engine";
import {
  EXCLUSION_LABELS,
  EXCLUSION_REASONS,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
} from "@/lib/iegp/enums";

type AvailableTactic = { id: string; name: string };

function GapTacticsBlock({
  gapId,
  residualId,
  tactics,
  availableTactics,
}: {
  gapId: string;
  residualId?: string | null;
  tactics: PlanTactic[];
  availableTactics: AvailableTactic[];
}) {
  const unmapped = availableTactics.filter((t) => !tactics.some((mapped) => mapped.id === t.id));
  return (
    <div className="mt-3">
      <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">Tactics</h3>
      {tactics.length === 0 ? (
        <p className="mt-1 text-[12px] text-muted-foreground">None</p>
      ) : (
        <ul className="mt-1 grid gap-1.5">
          {tactics.map((tactic) => (
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
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {unmapped.length > 0 ? (
          <LockForm
            label="Assign tactic"
            action="assign_tactic"
            extra={{ gap_id: gapId }}
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
        ) : availableTactics.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No accepted tactic to assign yet.</p>
        ) : null}
        <LockForm
          label="Create tactic"
          action="create_tactic"
          extra={{
            gap_id: gapId,
            residual_ids: residualId ?? "",
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
    </div>
  );
}

export function ReviewCard({
  card,
  availableTactics,
}: {
  card: ReviewGapCard;
  availableTactics: AvailableTactic[];
}) {
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
      <p className="mt-2 text-[12px] leading-5 text-foreground">Residual: {card.residual}</p>
      {card.needs.length > 0 ? (
        <ul className="mt-2 grid gap-1 text-[11px] text-muted-foreground">
          {card.needs.map((need) => (
            <li key={need.id}>{need.statement}</li>
          ))}
        </ul>
      ) : null}
      <GapTacticsBlock
        gapId={card.gap_id}
        residualId={card.residual_id}
        tactics={card.tactics}
        availableTactics={availableTactics}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <LockForm
          label="Accept gap"
          action="lock_gap"
          extra={{ gap_id: card.gap_id, status: "validated_open" }}
          confirmLabel="Accept"
        />
        <LockForm
          label="Reject gap"
          action="lock_gap"
          extra={{ gap_id: card.gap_id, status: "excluded" }}
          confirmLabel="Reject"
        >
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
        <LockForm
          label="Modify gap"
          action="modify_gap"
          extra={{ gap_id: card.gap_id }}
          confirmLabel="Save"
        >
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

export function ReviewTacticCardView({ card }: { card: ReviewTacticCard }) {
  return (
    <article className="border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <TacticReviewBadge status="candidate" />
        <span className="text-[11px] text-muted-foreground">{TACTIC_TYPE_LABELS[card.type]}</span>
      </div>
      <Link
        href={`/tactics/${card.tactic_id}`}
        className="mt-2 block text-[13px] font-medium text-foreground no-underline hover:underline"
      >
        {card.name}
      </Link>
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{card.evidence_question}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <LockForm
          label="Accept tactic"
          action="lock_tactic_review"
          extra={{ tactic_id: card.tactic_id, review_status: "accepted" }}
          confirmLabel="Accept"
        />
        <LockForm
          label="Reject tactic"
          action="lock_tactic_review"
          extra={{ tactic_id: card.tactic_id, review_status: "rejected" }}
          confirmLabel="Reject"
        >
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Why reject
            <textarea
              name="note"
              required
              placeholder="Not a real tactic, duplicative, or dissemination only."
              className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground"
            />
          </label>
        </LockForm>
        <LockForm
          label="Modify tactic"
          action="modify_tactic"
          extra={{ tactic_id: card.tactic_id }}
          confirmLabel="Save"
        >
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Name
            <input
              name="name"
              required
              defaultValue={card.name}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
            />
          </label>
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Evidence question
            <textarea
              name="evidence_question"
              required
              defaultValue={card.evidence_question}
              className="min-h-20 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground"
            />
          </label>
        </LockForm>
      </div>
    </article>
  );
}

export function PrioritizeCard({
  card,
  availableTactics,
}: {
  card: UnprioritizedGapCard;
  availableTactics: AvailableTactic[];
}) {
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
      <GapTacticsBlock
        gapId={card.gap_id}
        residualId={card.residual_id}
        tactics={card.tactics}
        availableTactics={availableTactics}
      />
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

export function GapPlanCard({
  card,
  availableTactics,
}: {
  card: PlanGapCard;
  availableTactics: AvailableTactic[];
}) {
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
      <GapTacticsBlock
        gapId={card.gap_id}
        residualId={card.residual_id}
        tactics={card.tactics}
        availableTactics={availableTactics}
      />
    </article>
  );
}

export function ReviewQueue({
  gaps,
  tactics,
  emptyHint,
  availableTactics,
}: {
  gaps: ReviewGapCard[];
  tactics: ReviewTacticCard[];
  emptyHint: string;
  availableTactics: AvailableTactic[];
}) {
  if (gaps.length === 0 && tactics.length === 0) {
    return <p className="text-[12px] text-muted-foreground">{emptyHint}</p>;
  }
  return (
    <div className="grid gap-8">
      <section aria-labelledby="review-gaps">
        <h3 id="review-gaps" className="mb-3 text-[13px] font-medium text-foreground">
          Gaps
        </h3>
        {gaps.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No candidate gaps in the queue.</p>
        ) : (
          <div className="grid gap-3">
            {gaps.map((card) => (
              <ReviewCard key={card.gap_id} card={card} availableTactics={availableTactics} />
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="review-tactics">
        <h3 id="review-tactics" className="mb-3 text-[13px] font-medium text-foreground">
          Tactics
        </h3>
        {tactics.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No candidate tactics in the queue.</p>
        ) : (
          <div className="grid gap-3">
            {tactics.map((card) => (
              <ReviewTacticCardView key={card.tactic_id} card={card} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function PrioritizeQueue({
  cards,
  availableTactics,
}: {
  cards: UnprioritizedGapCard[];
  availableTactics: AvailableTactic[];
}) {
  if (cards.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        All accepted gaps with residuals have a human-locked priority.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      {cards.map((card) => (
        <PrioritizeCard key={card.gap_id} card={card} availableTactics={availableTactics} />
      ))}
    </div>
  );
}
