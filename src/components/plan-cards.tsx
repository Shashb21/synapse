import Link from "next/link";
import {
  CoverageBadge,
  PriorityBadge,
  TacticBadge,
} from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { GapFormFields } from "@/components/gap-form-fields";
import { CustomTypeFields } from "@/components/custom-type-fields";
import type { CustomTacticType } from "@/lib/iegp/custom-tactic-type";
import { TacticDetailFields } from "@/components/gap-tactic-actions";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import type {
  PlanGapCard,
  PlanTactic,
  TacticLibraryItem,
  UnprioritizedGapCard,
} from "@/lib/iegp/engine";
import {
  CATCH_UP_TACTIC_STATUSES,
  CREATE_TACTIC_STATUS_LABELS,
  CREATE_TACTIC_STATUSES,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
} from "@/lib/iegp/enums";

type AvailableTactic = TacticLibraryItem;

function tacticOptionLabel(tactic: TacticLibraryItem) {
  if (tactic.gaps.length === 0) return `${tactic.name} · not tagged yet`;
  if (tactic.gaps.length === 1) return `${tactic.name} · 1 gap`;
  return `${tactic.name} · ${tactic.gaps.length} gaps`;
}

export function CreateGapButton({
  label = "Create gap",
  variant,
}: { label?: string; variant?: "default" | "outline" } = {}) {
  return (
    <LockForm label={label} action="create_gap" confirmLabel="Add gap" variant={variant} size="lg">
      <GapFormFields />
    </LockForm>
  );
}

export function CreateTacticButton({ inUse = [] }: { inUse?: CustomTacticType[] } = {}) {
  return (
    <LockForm
      label="Create tactic"
      action="create_tactic"
      confirmLabel="Add to library"
      description="Add a tactic to the library. A proposed tactic is an idea and does not count as addressing; planned, ongoing and completed ones do."
    >
      <input type="hidden" name="origin" value="tactics" />
      <CreateTacticFields inUse={inUse} />
    </LockForm>
  );
}

/** A new proposed tactic written by hand for one gap, mapped onto it at once (Tactic Ideation). */
export function CustomTacticButton({
  gapId,
  gapName,
  inUse = [],
}: {
  gapId: string;
  gapName: string;
  inUse?: CustomTacticType[];
}) {
  return (
    <LockForm
      label="+ Custom tactic"
      action="create_tactic"
      extra={{ gap_id: gapId }}
      confirmLabel="Add tactic"
      variant="default"
      description={`Write a tactic for ${gapName}. It goes into the library mapped onto this gap. A proposed tactic is an idea and does not count as addressing.`}
    >
      <input type="hidden" name="origin" value="tactics" />
      <CreateTacticFields inUse={inUse} />
    </LockForm>
  );
}

/** Tag a library tactic onto one gap; the tactic is shared, not copied. */
export function AssignTacticButton({
  gapId,
  tactics,
}: {
  gapId: string;
  tactics: TacticLibraryItem[];
}) {
  if (tactics.length === 0) return null;
  return (
    <LockForm label="Assign from library" action="assign_tactic" extra={{ gap_id: gapId }} confirmLabel="Assign">
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        From tactic library
        <select
          name="tactic_id"
          required
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
        >
          {tactics.map((tactic) => (
            <option key={tactic.id} value={tactic.id}>
              {tacticOptionLabel(tactic)}
            </option>
          ))}
        </select>
      </label>
    </LockForm>
  );
}

function CreateTacticFields({ inUse = [] }: { inUse?: CustomTacticType[] }) {
  return (
    <>
      <input
        name="name"
        required
        placeholder="Tactic name"
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      />
      <select
        name="type"
        required
        defaultValue=""
        aria-label="Tactic type"
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        <option value="" disabled>
          Choose a type
        </option>
        {TACTIC_TYPES.map((type) => (
          <option key={type} value={type}>
            {TACTIC_TYPE_LABELS[type]}
          </option>
        ))}
      </select>
      <CustomTypeFields inUse={inUse} />
      <input
        name="evidence_question"
        required
        placeholder="Evidence question"
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      />
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Status
        <select
          name="status"
          defaultValue="proposed"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
        >
          {CREATE_TACTIC_STATUSES.map((status) => (
            <option key={status} value={status}>
              {CREATE_TACTIC_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground/80">
          Pick Planned, Ongoing or Completed for a real study you already have.
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Start date (optional)
          <input
            name="start_date"
            type="date"
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
          />
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Evidence available (optional)
          <input
            name="evidence_available"
            type="date"
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
          />
        </label>
      </div>
      <TacticDetailFields />
    </>
  );
}


/**
 * An existing study or programme entered by hand (completed, ongoing, or
 * planned). It goes into the tactic library, ready to map onto gaps.
 */
export function AddTacticsButton({
  variant,
  inUse = [],
}: { variant?: "default" | "outline"; inUse?: CustomTacticType[] } = {}) {
  return (
    <LockForm
      label="Add tactics"
      action="record_missed_tactic"
      confirmLabel="Add to library"
      variant={variant}
      description="Record a study or programme you already have. Map it onto gaps on Gaps. Proposed new tactics are ideated on Tactics after Prioritize."
    >
      <input
        name="name"
        required
        placeholder="Study, programme, or publication name"
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      />
      <select
        name="type"
        required
        defaultValue=""
        aria-label="Tactic type"
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        <option value="" disabled>
          Choose a type
        </option>
        {TACTIC_TYPES.map((type) => (
          <option key={type} value={type}>
            {TACTIC_TYPE_LABELS[type]}
          </option>
        ))}
      </select>
      <CustomTypeFields inUse={inUse} />
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Status
        <select
          name="status"
          required
          defaultValue=""
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
        >
          <option value="" disabled>
            Choose a status
          </option>
          {CATCH_UP_TACTIC_STATUSES.map((status) => (
            <option key={status} value={status}>
              {CREATE_TACTIC_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <input
        name="evidence_question"
        required
        placeholder="Evidence question"
        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      />
      <TacticDetailFields />
    </LockForm>
  );
}

/**
 * The first screen with AI off: nothing is uploaded or parsed, so the plan
 * starts from two hand-entry actions.
 */
export function ManualStart({ gapCount, tacticCount }: { gapCount: number; tacticCount: number }) {
  return (
    <section aria-labelledby="manual-start" className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="border border-border bg-card p-4 rounded-lg">
          <h2 id="manual-start" className="text-[13px] font-semibold text-foreground">
            Gaps
          </h2>
          <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
            Type each evidence gap: what is missing and its domain.{" "}
            {gapCount > 0 ? `${gapCount} so far.` : "None yet."}
          </p>
          <CreateGapButton label="Add gaps" variant="default" />
        </div>
        <div className="border border-border bg-card p-4 rounded-lg">
          <h2 className="text-[13px] font-semibold text-foreground">Tactics</h2>
          <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
            Record the studies and programmes you already have.{" "}
            {tacticCount > 0 ? `${tacticCount} in the library.` : "None yet."}
          </p>
          <AddTacticsButton variant="default" />
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Then map tactics onto gaps and confirm each gap on{" "}
        <Link href="/?place=gaps" className="text-foreground">
          Gaps
        </Link>
        , prioritize them by hand, and date the plan on{" "}
        <Link href="/timeline" className="text-foreground">
          Timeline
        </Link>
        .
      </p>
    </section>
  );
}

/**
 * The first screen with AI on: uploading is one way in, typing is the other.
 * A plan can start by hand before anything is ingested, and a model never has
 * to run first.
 */
export function ManualStartAlongsideUpload({ gapCount, tacticCount }: { gapCount: number; tacticCount: number }) {
  return (
    <section
      aria-labelledby="manual-start-ai-on"
      data-testid="manual-start-ai-on"
      className="mb-8 flex flex-wrap items-center gap-3 border border-border bg-card p-4 rounded-lg"
    >
      <div className="min-w-0 flex-1">
        <h2 id="manual-start-ai-on" className="text-[13px] font-semibold text-foreground">
          Start by hand
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          You don&apos;t have to upload first. Type the gaps you know and record the studies you
          already have; anything you ingest later joins them.{" "}
          {gapCount > 0 || tacticCount > 0
            ? `${gapCount} gap${gapCount === 1 ? "" : "s"} and ${tacticCount} tactic${tacticCount === 1 ? "" : "s"} so far.`
            : "Nothing added yet."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CreateGapButton label="Add gaps" variant="outline" />
        <AddTacticsButton variant="outline" />
      </div>
    </section>
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
            Tactic library is empty. Create a tactic on Gaps or Tactics, or add one on the first screen.
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
    <article className="border border-border bg-card p-4 rounded-lg">
      <div className="flex flex-wrap items-center gap-1.5">
        <GapStatusOverride
          gapId={card.gap_id}
          status={card.gap_status}
          computedStatus={card.computed_status}
          override={card.status_override}
        />
        <span className="text-[11px] text-amber-700 dark:text-amber-300">Priority unlocked</span>
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
          note={{ label: "Reason for this band (optional)" }}
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
    <article className="border border-border bg-card p-3 rounded-lg">
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
