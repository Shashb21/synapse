import Link from "next/link";
import {
  CoverageBadge,
  PriorityBadge,
  StaleFlag,
  TacticBadge,
} from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import type {
  OpenGapCard,
  PlanGapCard,
  PlanTactic,
  TacticLibraryItem,
  UnprioritizedGapCard,
} from "@/lib/iegp/engine";
import {
  DOMAIN_LABELS,
  EVIDENCE_DOMAINS,
  GAP_STATUS_LABELS,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
} from "@/lib/iegp/enums";

type AvailableTactic = TacticLibraryItem;

function tacticOptionLabel(tactic: TacticLibraryItem) {
  if (tactic.gaps.length === 0) return `${tactic.name} · not tagged yet`;
  if (tactic.gaps.length === 1) return `${tactic.name} · 1 gap`;
  return `${tactic.name} · ${tactic.gaps.length} gaps`;
}

function CreateGapFields() {
  return (
    <>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Name (optional — derived as an evidence-topic title if blank)
        <input
          name="name"
          placeholder="Comparative effectiveness in elderly patients, including SoC outcomes"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Statement
        <textarea
          name="statement"
          required
          placeholder="What evidence is missing."
          className="min-h-20 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Domain
        <select
          name="domain"
          defaultValue="unmet_need"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
        >
          {EVIDENCE_DOMAINS.map((domain) => (
            <option key={domain} value={domain}>
              {DOMAIN_LABELS[domain]}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function CreateGapButton() {
  return (
    <LockForm label="Create gap" action="create_gap" confirmLabel="Add gap">
      <CreateGapFields />
    </LockForm>
  );
}

function CreateTacticButton() {
  return (
    <LockForm label="Create tactic" action="create_tactic" confirmLabel="Add to library">
      <CreateTacticFields />
    </LockForm>
  );
}

function CreateTacticFields() {
  return (
    <>
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
    </>
  );
}


function CreateActions() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <CreateGapButton />
      <CreateTacticButton />
    </div>
  );
}

function GapTacticsBlock({
  gapId,
  tactics,
  availableTactics,
}: {
  gapId: string;
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
              From tactic library
              <select
                name="tactic_id"
                required
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
              >
                {unmapped.map((tactic) => (
                  <option key={tactic.id} value={tactic.id}>
                    {tacticOptionLabel(tactic)}
                  </option>
                ))}
              </select>
            </label>
          </LockForm>
        ) : availableTactics.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Tactic library is empty. Create a tactic on Gaps or Tactics, or ingest a source on Upload.
          </p>
        ) : null}
      </div>
    </div>
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
        <GapStatusOverride
          gapId={card.gap_id}
          status={card.gap_status}
          computedStatus={card.computed_status}
          override={card.status_override}
        />
        <span className="text-[11px] text-amber-300">Priority unlocked</span>
      </div>
      <GapStatusDisagreement computedStatus={card.computed_status} override={card.status_override} />
      <Link
        href={`/gaps/${card.gap_id}`}
        className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
      >
        {card.gap_name}
      </Link>
      <GapTacticsBlock
        gapId={card.gap_id}
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
        <GapStatusOverride
          gapId={card.gap_id}
          status={card.gap_status}
          computedStatus={card.computed_status}
          override={card.status_override}
        />
      </div>
      <GapStatusDisagreement computedStatus={card.computed_status} override={card.status_override} />
      <Link
        href={`/gaps/${card.gap_id}`}
        className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
      >
        {card.gap_name}
      </Link>
      <GapTacticsBlock
        gapId={card.gap_id}
        tactics={card.tactics}
        availableTactics={availableTactics}
      />
    </article>
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
        No Open gaps to prioritize. Validate Open gaps on Gaps first. Partial must be split or rewritten.
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

export function TacticLibrary({ items }: { items: TacticLibraryItem[] }) {
  return (
    <section aria-labelledby="tactic-library">
      <p id="tactic-library" className="mb-4 text-[12px] text-muted-foreground">
        Tag the same tactic onto as many gaps as you need — it is not copied.
      </p>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Empty. Ingest a source on Upload, or create a tactic here.
        </p>
      ) : (
        <ul className="grid gap-2">
          {items.map((item) => (
            <li key={item.id} className="border border-border bg-background p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link
                  href={`/tactics/${item.id}`}
                  className="text-[13px] font-medium text-foreground no-underline hover:underline"
                >
                  {item.name}
                </Link>
                <span className="text-[11px] text-muted-foreground">
                  {TACTIC_TYPE_LABELS[item.type]}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {item.gaps.length === 0
                  ? "Not tagged to a gap yet."
                  : `Tagged on ${item.gaps.map((g) => g.name).join(" · ")}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <CreateActions />
      </div>
    </section>
  );
}

export function OpenGapsQueue({
  cards,
  availableTactics,
}: {
  cards: OpenGapCard[];
  availableTactics: AvailableTactic[];
}) {
  if (cards.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        Prioritize Open gaps first, then assign tactics here.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      {cards.map((card) => (
        <article key={card.gap_id} className="border border-border bg-background p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <GapStatusOverride
              gapId={card.gap_id}
              status={card.gap_status}
              computedStatus={card.computed_status}
              override={card.status_override}
            />
            {card.parent_gap_id ? (
              <span className="text-[11px] text-muted-foreground">Leftover of parent</span>
            ) : null}
          </div>
          <Link
            href={`/gaps/${card.gap_id}`}
            className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
          >
            {card.gap_name}
          </Link>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Engine computed {GAP_STATUS_LABELS[card.computed_status]}. Click the status to override
            with a reason. Completed, ongoing, and planned tactics count; proposed does not.
          </p>
          <GapStatusDisagreement
            computedStatus={card.computed_status}
            override={card.status_override}
          />
          <GapTacticsBlock
            gapId={card.gap_id}
            tactics={card.tactics}
            availableTactics={availableTactics}
          />
        </article>
      ))}
    </div>
  );
}
