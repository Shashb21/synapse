import Link from "next/link";
import { GapBadge } from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import { SplitGapDialog } from "@/components/split-gap-dialog";
import { GapStatusGuide } from "@/components/gap-status-guide";
import {
  DOMAIN_LABELS,
  EVIDENCE_DOMAINS,
  GAP_STATUS_LABELS,
  TACTIC_TYPE_LABELS,
  TACTIC_TYPES,
} from "@/lib/iegp/enums";
import type { ReviewGapCard, TacticLibraryItem } from "@/lib/iegp/engine";
import { CoverageBadge, StaleFlag, TacticBadge } from "@/components/iegp-badges";

function CreateOpenGap() {
  return (
    <LockForm label="Add open gap" action="create_gap" confirmLabel="Add open gap">
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Title
        <input
          name="name"
          placeholder="Comparative effectiveness in elderly patients, including SoC outcomes"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Statement
        <textarea
          name="statement"
          required
          className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Domain
        <select name="domain" defaultValue="unmet_need" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
          {EVIDENCE_DOMAINS.map((domain) => (
            <option key={domain} value={domain}>
              {DOMAIN_LABELS[domain]}
            </option>
          ))}
        </select>
      </label>
    </LockForm>
  );
}

function CreateAddressedGap({ tactics }: { tactics: TacticLibraryItem[] }) {
  return (
    <LockForm label="Add addressed gap" action="create_addressed_gap" confirmLabel="Add addressed gap">
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Title
        <input name="name" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Statement
        <textarea
          name="statement"
          required
          className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
        />
      </label>
      <label className="grid gap-1 text-[12px] text-muted-foreground">
        Accompanying tactic
        <select name="tactic_id" required className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
          {tactics.map((tactic) => (
            <option key={tactic.id} value={tactic.id}>
              {tactic.name}
            </option>
          ))}
        </select>
      </label>
      {tactics.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Create a tactic first (planned, ongoing, completed, or a publication).
        </p>
      ) : null}
    </LockForm>
  );
}

function CreateTacticInline() {
  return (
    <LockForm label="Add tactic" action="create_tactic" confirmLabel="Add tactic">
      <input name="name" required placeholder="Tactic name" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
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
      <input type="hidden" name="description" value="Added from the gaps workbench." />
      <input type="hidden" name="population" value="To be specified" />
      <input type="hidden" name="intervention" value="Velmara" />
      <input type="hidden" name="comparator" value="To be specified" />
      <input type="hidden" name="outcomes" value="To be specified" />
      <input type="hidden" name="geography" value="US + EU5" />
      <input type="hidden" name="owner" value="" />
      <input type="hidden" name="function" value="evidence_lead" />
    </LockForm>
  );
}

export function GapsWorkbench({
  cards,
  availableTactics,
  readyForPrioritize,
}: {
  cards: ReviewGapCard[];
  availableTactics: TacticLibraryItem[];
  readyForPrioritize: boolean;
}) {
  const partials = cards.filter((c) => c.gap_status === "validated_partial").length;
  const unvalidated = cards.filter((c) => !c.human_validated || c.gap_status === "validated_partial").length;

  return (
    <div className="grid gap-6">
      <GapStatusGuide compact />
      <div className="flex flex-wrap items-center gap-2">
        <CreateOpenGap />
        <CreateAddressedGap tactics={availableTactics} />
        <CreateTacticInline />
      </div>
      <p className="text-[12px] text-muted-foreground">
        Engine computes Open / Partially Addressed / Addressed from completed, ongoing, and planned
        tactics and published literature. Proposed tactics do not count. Validate each gap to
        proceed. Partial cannot stay — split or rewrite it.
      </p>
      {cards.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No mapped gaps yet. Ingest a source on Upload, or add an Open or Addressed gap here.
        </p>
      ) : (
        <div className="grid gap-3">
          {cards.map((card) => (
            <article key={card.gap_id} className="border border-border bg-background p-4">
              <div className="flex flex-wrap items-center gap-2">
                {card.gap_status === "validated_partial" ? (
                  <SplitGapDialog
                    gapId={card.gap_id}
                    gapName={card.gap_name}
                    residualName={card.residual?.statement || card.gap_name}
                    tactics={card.tactics}
                  >
                    <GapBadge status={card.gap_status} />
                  </SplitGapDialog>
                ) : (
                  <GapStatusOverride
                    gapId={card.gap_id}
                    status={card.gap_status}
                    computedStatus={card.computed_status}
                    override={card.status_override}
                  />
                )}
                {card.human_validated ? (
                  <span className="text-[11px] text-muted-foreground">Validated</span>
                ) : (
                  <span className="text-[11px] text-amber-300">Needs validation</span>
                )}
                {card.parent_gap_id ? (
                  <span className="text-[11px] text-muted-foreground">From split / rewrite</span>
                ) : null}
                {card.history_count > 0 ? (
                  <span className="text-[11px] text-muted-foreground">
                    {card.history_count} version{card.history_count === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              <Link
                href={`/gaps/${card.gap_id}`}
                className="mt-2 block text-[13px] leading-5 text-foreground no-underline hover:underline"
              >
                {card.gap_name}
              </Link>
              <GapStatusDisagreement
                computedStatus={card.computed_status}
                override={card.status_override}
              />
              <ul className="mt-3 grid gap-1">
                {card.tactics.length === 0 ? (
                  <li className="text-[12px] text-muted-foreground">No mapped tactics.</li>
                ) : (
                  card.tactics.map((tactic) => (
                    <li key={tactic.id}>
                      <Link
                        href={`/tactics/${tactic.id}`}
                        className="inline-flex flex-wrap items-center gap-1.5 text-[12px] no-underline hover:underline"
                      >
                        <span>{tactic.name}</span>
                        <TacticBadge status={tactic.status} />
                        {tactic.overall ? <CoverageBadge overall={tactic.overall} /> : null}
                        {tactic.stale ? <StaleFlag stale /> : null}
                      </Link>
                    </li>
                  ))
                )}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {card.gap_status === "validated_partial" ? null : !card.human_validated ? (
                  <LockForm
                    label="Validate status"
                    action="validate_gap"
                    extra={{ gap_id: card.gap_id }}
                    confirmLabel={`Validate ${GAP_STATUS_LABELS[card.gap_status]}`}
                  />
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="border border-border bg-card/40 p-4">
        {readyForPrioritize ? (
          <>
            <h2 className="text-[15px] font-medium">Continue to prioritize</h2>
            <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
              Every live gap is validated. Open gaps go to Prioritize, then Tactics.
            </p>
            <LockForm
              label="Continue to prioritize"
              action="complete_wizard"
              confirmLabel="Go to prioritize"
            />
          </>
        ) : (
          <>
            <h2 className="text-[15px] font-medium">Prioritize is locked</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {unvalidated} gap{unvalidated === 1 ? "" : "s"} still need validation
              {partials ? ` · ${partials} partial must be split or rewritten` : ""}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
