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
  MappingSuggestion,
  OpenGapCard,
  PlanGapCard,
  PlanTactic,
  ResidualGapSuggestion,
  ReviewGapCard,
  ReviewTacticCard,
  TacticLibraryItem,
  UnprioritizedGapCard,
} from "@/lib/iegp/engine";
import {
  DOMAIN_LABELS,
  EVIDENCE_DOMAINS,
  EXCLUSION_LABELS,
  EXCLUSION_REASONS,
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
        Name (optional — derived from the statement if blank)
        <input
          name="name"
          placeholder="Gap name"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Statement
        <textarea
          name="statement"
          required
          placeholder="What evidence is missing, in one sentence."
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
            Tactic library is empty. Accept an extracted tactic in Review, or create one in Library.
          </p>
        ) : null}
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
        className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
      >
        {card.statement}
      </Link>
      <GapTacticsBlock
        gapId={card.gap_id}
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
        className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
      >
        {card.statement}
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
        <GapBadge status={card.gap_status} />
      </div>
      <Link
        href={`/gaps/${card.gap_id}`}
        className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
      >
        {card.statement}
      </Link>
      <GapTacticsBlock
        gapId={card.gap_id}
        tactics={card.tactics}
        availableTactics={availableTactics}
      />
    </article>
  );
}

export function ReviewQueue({
  gaps,
  tactics,
  residuals,
  emptyHint,
  availableTactics,
}: {
  gaps: ReviewGapCard[];
  tactics: ReviewTacticCard[];
  residuals: ResidualGapSuggestion[];
  emptyHint: string;
  availableTactics: AvailableTactic[];
}) {
  if (gaps.length === 0 && tactics.length === 0 && residuals.length === 0) {
    return (
      <div className="grid gap-3">
        <p className="text-[12px] text-muted-foreground">{emptyHint}</p>
        <CreateActions />
      </div>
    );
  }
  return (
    <div className="grid gap-8">
      <section aria-labelledby="review-gaps">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 id="review-gaps" className="text-[13px] font-medium text-foreground">
            Gaps
          </h3>
          <CreateActions />
        </div>
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
      <SuggestedResidualGaps items={residuals} />
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
        No leftover to prioritize. Open accepted gaps wait on Mappings for tactics and coverage.
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

export function SuggestedResidualGaps({ items }: { items: ResidualGapSuggestion[] }) {
  return (
    <section aria-labelledby="review-residuals">
      <h3 id="review-residuals" className="mb-3 text-[13px] font-medium text-foreground">
        Residual evidence needs
      </h3>
      <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
        The leftover question after pressure-testing extracted tactics against the parent. Accept
        residual creates that leftover as a new gap (parent stays). Reject persists. Modify edits
        the leftover statement — not a copy of the parent sentence.
      </p>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No residual evidence needs. The engine drafts one when pressure-testing says a parent is
          already partial versus extracted tactics.
        </p>
      ) : (
        <div className="grid gap-3">
          {items.map((item) => (
            <article key={item.parent_gap_id} className="border border-border bg-background p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Residual evidence need
              </p>
              <p className="mt-2 text-[13px] leading-5 text-foreground">{item.statement}</p>
              <p className="mt-2 text-[12px] text-muted-foreground">Parent: {item.parent_name}</p>
              <ul className="mt-2 grid gap-1">
                {item.reasons.map((reason) => (
                  <li key={reason} className="text-[12px] leading-5 text-muted-foreground">
                    {reason}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <LockForm
                  label="Accept residual"
                  action="accept_residual_gap"
                  extra={{ parent_gap_id: item.parent_gap_id, statement: item.statement }}
                  confirmLabel="Add as gap"
                />
                <LockForm
                  label="Reject residual"
                  action="reject_residual_gap"
                  extra={{ parent_gap_id: item.parent_gap_id }}
                  confirmLabel="Reject residual"
                />
                <LockForm
                  label="Modify residual"
                  action="modify_residual_gap"
                  extra={{ parent_gap_id: item.parent_gap_id }}
                  confirmLabel="Save statement"
                >
                  <label className="grid gap-1 text-[12px] text-muted-foreground">
                    Residual statement
                    <textarea
                      name="statement"
                      required
                      defaultValue={item.statement}
                      className="min-h-20 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm text-foreground"
                    />
                  </label>
                </LockForm>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function SuggestedMappings({ items }: { items: MappingSuggestion[] }) {
  return (
    <section aria-labelledby="suggested-mappings">
      <h2 id="suggested-mappings" className="text-[15px] font-medium text-foreground">
        Suggested mappings
      </h2>
      <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
        A scored mapping engine drafts inventory joins (wording, domain/type fit, shared IEGP cues).
        Accept writes a coverage join. Reject keeps the pair off this list. Nothing is auto-assigned,
        and this is not an LLM.
      </p>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No mapping suggestions. Accept a gap and a tactic, or create a tactic in Library.
        </p>
      ) : (
        <ul className="grid gap-3">
          {items.map((item) => (
            <li
              key={`${item.gap_id}::${item.tactic_id}`}
              className="border border-border bg-background p-4"
            >
              <p className="text-[13px] leading-5 text-foreground">{item.gap_statement}</p>
              <p className="mt-2 text-[12px] text-foreground">
                Tactic:{" "}
                <Link
                  href={`/tactics/${item.tactic_id}`}
                  className="font-medium text-foreground no-underline hover:underline"
                >
                  {item.tactic_name}
                </Link>
              </p>
              <ul className="mt-2 grid gap-1">
                {item.reasons.map((reason) => (
                  <li key={reason} className="text-[12px] leading-5 text-muted-foreground">
                    {reason}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <LockForm
                  label="Accept mapping"
                  action="accept_mapping"
                  extra={{ gap_id: item.gap_id, tactic_id: item.tactic_id }}
                  confirmLabel="Accept mapping"
                />
                <LockForm
                  label="Reject mapping"
                  action="reject_mapping"
                  extra={{ gap_id: item.gap_id, tactic_id: item.tactic_id }}
                  confirmLabel="Reject mapping"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
          Empty. Accept an extracted tactic in Review, or create one here.
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
        Accept a gap in Review, then map or assign a library tactic.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      {cards.map((card) => (
        <article key={card.gap_id} className="border border-border bg-background p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <GapBadge status={card.gap_status} />
            {card.parent_gap_id ? (
              <span className="text-[11px] text-muted-foreground">Leftover of parent</span>
            ) : null}
          </div>
          <Link
            href={`/gaps/${card.gap_id}`}
            className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
          >
            {card.statement}
          </Link>
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
