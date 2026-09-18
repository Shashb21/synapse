import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { CoverageBadge, GapBadge, LockMeta, NeedsReviewFlag, StaleFlag } from "@/components/iegp-badges";
import { CoverageDimensionsMenu } from "@/components/coverage-dimensions-menu";
import { LockForm } from "@/components/lock-form";
import { MapExistingTactic, RecordMissedTactic } from "@/components/gap-tactic-actions";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import { SplitGapDialog } from "@/components/split-gap-dialog";
import {
  COVERAGE_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_QUESTIONS,
  DIMENSION_VALUES,
  EXCLUSION_LABELS,
  EXCLUSION_REASONS,
  GAP_STATUS_DEFINITIONS,
  GAP_STATUS_LABELS,
  OVERALL_COVERAGE,
} from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import {
  buildTacticLibrary,
  computeGapStatus,
  coverageDimensionValues,
  displayedGapStatus,
  liveGapsMappedToTactic,
  mappedTactics,
  suggestResidualGaps,
  uncoveredDimensions,
} from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

export default async function GapDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const state = await loadState();
  const gap = state.gaps.find((g) => g.id === id);
  if (!gap) notFound();
  const needs = state.need_gap_links
    .filter((l) => l.gap_id === gap.id)
    .map((l) => ({ link: l, need: state.needs.find((n) => n.id === l.need_id)! }))
    .filter((x) => x.need);
  const coverages = state.coverages.filter((c) => c.gap_id === gap.id);
  const children = state.gaps.filter((g) => g.parent_gap_id === gap.id);
  const computed = computeGapStatus(coverages, state.tactics, {
    hasAcceptedChild: children.length > 0,
  });
  const shown = displayedGapStatus({
    ...gap,
    computed_status: gap.computed_status ?? computed,
  });
  const missing = uncoveredDimensions(coverages);
  const leftover = suggestResidualGaps(state).find((row) => row.parent_gap_id === gap.id);
  const tactics = mappedTactics(state, gap.id);
  const library = buildTacticLibrary(state);
  const parent = gap.parent_gap_id
    ? state.gaps.find((g) => g.id === gap.parent_gap_id)
    : undefined;

  const mapped =
    shown === "validated_open" || shown === "validated_partial" || shown === "validated_addressed";

  return (
    <AppShell active="gaps">
      <PageIntro kicker={gap.id} title={gap.name} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {shown === "validated_partial" ? (
          <SplitGapDialog
            gapId={gap.id}
            gapName={gap.name}
            gapStatement={gap.statement}
            residualName={leftover?.statement || gap.name}
            residualStatement={leftover?.statement || gap.statement}
            tactics={tactics}
          >
            <GapBadge status={shown} />
          </SplitGapDialog>
        ) : mapped ? (
          <GapStatusOverride
            gapId={gap.id}
            status={shown}
            computedStatus={computed}
            override={gap.status_override}
          />
        ) : (
          <GapBadge status={shown} />
        )}
        {mapped && !gap.status_override ? (
          <span className="text-[11px] text-muted-foreground">
            Engine computed {GAP_STATUS_LABELS[computed]}
          </span>
        ) : (
          <LockMeta lock={gap.status_lock} />
        )}
      </div>
      <GapStatusDisagreement computedStatus={computed} override={gap.status_override} />
      <p className="mb-6 text-[12px] leading-5 text-muted-foreground">
        {GAP_STATUS_DEFINITIONS[shown]}{" "}
        {shown === "validated_partial"
          ? "Click Partially Addressed to split (Addressed + tactic on the left, Open leftover on the right) or rewrite the original. Partial cannot stay."
          : "Click Open or Addressed to override with a required reason. Cancel does not change status."}
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-[13px] text-muted-foreground">Constituent needs</h2>
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          A gap is the decision object. Constituent needs are the sourced statements underneath it.
          Role is primary or supporting. Many needs can join one gap without copying the statement
          onto the card.
        </p>
        <div className="grid gap-2">
          {needs.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No constituent needs yet.</p>
          ) : (
            needs.map(({ need, link }) => {
              const source = state.sources.find((s) => s.id === need.source_id);
              return (
                <p key={need.id} className="border border-border bg-card p-3 text-[13px]">
                  <span className="text-[11px] capitalize text-muted-foreground">
                    {link.role} · {source?.title || need.source_id}
                  </span>
                  <br />
                  {need.statement}
                </p>
              );
            })
          )}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-[13px] text-muted-foreground">
          Tactic mappings (many-to-many, dimensional)
        </h2>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Uncovered or partial dimensions: {missing.join(", ") || "none"}. A tactic existing is not
          coverage. A publication existing is not coverage.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <MapExistingTactic
            gapId={gap.id}
            availableTactics={library}
            mappedTacticIds={coverages.map((c) => c.tactic_id)}
          />
          <RecordMissedTactic gapId={gap.id} />
        </div>
        {coverages.map((c) => {
          const tactic = state.tactics.find((t) => t.id === c.tactic_id);
          const siblings = liveGapsMappedToTactic(state, c.tactic_id, gap.id);
          return (
            <article key={c.id} className="mb-4 border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/tactics/${c.tactic_id}`} className="text-[13px] text-foreground">
                  {tactic?.name}
                </Link>
                <CoverageBadge overall={c.overall} />
                <StaleFlag stale={c.stale} />
                <NeedsReviewFlag needsReview={c.needs_review} />
                <CoverageDimensionsMenu
                  overall={c.overall}
                  dimensions={coverageDimensionValues(c.dimensions)}
                />
              </div>
              {siblings.length > 0 ? (
                <div className="mt-3 border border-amber-500/30 bg-amber-500/10 p-3">
                  <p className="text-[12px] text-foreground">
                    Also mapped on {siblings.length} other gap{siblings.length === 1 ? "" : "s"}.
                    Coverage values stay per gap — changing this row flags siblings for review
                    without copying yes/partial/no.
                  </p>
                  <ul className="mt-2 grid gap-1">
                    {siblings.map((sibling) => (
                      <li key={sibling.id}>
                        <Link
                          href={`/gaps/${sibling.id}`}
                          className="text-[12px] text-foreground no-underline hover:underline"
                        >
                          {sibling.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {c.needs_review ? (
                <div className="mt-3 border border-border bg-card/40 p-3">
                  <p className="mb-2 text-[12px] text-muted-foreground">
                    Another live gap that uses this tactic changed a dimension or overall. Confirm
                    or edit this gap&apos;s own coverage. Status is not auto-flipped until you do.
                  </p>
                  <LockForm
                    label="Confirm coverage"
                    action="confirm_coverage_review"
                    extra={{ coverage_id: c.id }}
                    confirmLabel="Confirm coverage"
                    description="This records who confirmed coverage after a sibling-gap change. Values stay on this gap."
                  />
                </div>
              ) : null}
              <p className="mt-2 text-[12px] text-muted-foreground">{c.overall_rationale}</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 font-medium">Dimension</th>
                      <th className="py-1 font-medium">Assessment</th>
                      <th className="py-1 font-medium">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COVERAGE_DIMENSIONS.map((dim) => {
                      const cell = c.dimensions[dim];
                      return (
                        <tr key={dim} className="border-t border-border">
                          <td className="py-2 pr-3">
                            <div>{DIMENSION_LABELS[dim]}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {DIMENSION_QUESTIONS[dim]}
                            </div>
                          </td>
                          <td className="py-2 pr-3 capitalize">{cell.value}</td>
                          <td className="py-2">
                            <LockForm
                              label="Change dimension"
                              action="lock_dimension"
                              extra={{ coverage_id: c.id, dimension: dim }}
                              confirmLabel="Change dimension"
                              description="This records who changed coverage and flags other gaps that use this tactic. Dimension values are not copied across gaps."
                            >
                              <label className="grid gap-1 text-[12px] text-muted-foreground">
                                Value
                                <select
                                  name="value"
                                  defaultValue={cell.value}
                                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                                >
                                  {DIMENSION_VALUES.map((v) => (
                                    <option key={v} value={v}>
                                      {v}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <input type="hidden" name="rationale" value={cell.rationale} />
                            </LockForm>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3">
                <LockForm
                  label="Change overall coverage"
                  action="lock_overall"
                  extra={{ coverage_id: c.id }}
                  confirmLabel="Change overall coverage"
                  description="This records who changed coverage and flags other gaps that use this tactic. Overall values stay per gap."
                >
                  <label className="grid gap-1 text-[12px] text-muted-foreground">
                    Overall
                    <select
                      name="overall"
                      defaultValue={c.overall}
                      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
                    >
                      {OVERALL_COVERAGE.map((v) => (
                        <option key={v} value={v}>
                          {v.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[12px] text-muted-foreground">
                    Rationale
                    <textarea
                      name="rationale"
                      defaultValue={c.overall_rationale}
                      className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
                    />
                  </label>
                </LockForm>
              </div>
            </article>
          );
        })}
      </section>

      {parent ? (
        <p className="mb-6 text-[12px] text-muted-foreground">
          Leftover of{" "}
          <Link href={`/gaps/${parent.id}`} className="text-foreground no-underline hover:underline">
            {parent.statement}
          </Link>
        </p>
      ) : null}

      {children.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-[13px] text-muted-foreground">Leftover child gaps</h2>
          <div className="grid gap-2">
            {children.map((child) => (
              <Link
                key={child.id}
                href={`/gaps/${child.id}`}
                className="border border-border bg-card p-3 text-[13px] no-underline"
              >
                {child.name}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {leftover && shown === "validated_partial" ? (
        <section className="mb-8 border border-border bg-card p-4">
          <h2 className="text-[13px] text-muted-foreground">Suggested leftover (right side of split)</h2>
          <p className="mt-2 text-[13px] text-foreground">{leftover.statement}</p>
          <ul className="mt-2 grid gap-1">
            {leftover.reasons.map((reason) => (
              <li key={reason} className="text-[12px] leading-5 text-muted-foreground">
                {reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.gap_versions.filter((row) => row.live_gap_id === gap.id).length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-[13px] text-muted-foreground">Version history</h2>
          <ul className="grid gap-2">
            {state.gap_versions
              .filter((row) => row.live_gap_id === gap.id)
              .map((row) => (
                <li key={row.id} className="border border-border bg-card p-3 text-[13px]">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {row.event} · {row.retired_gap_id} · {row.at.slice(0, 10)} · {row.actor_name}
                  </p>
                  <p className="mt-1">{row.name}</p>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {shown === "excluded" ? null : shown === "candidate" ? null : (
        <LockForm
          label="Exclude gap"
          action="lock_gap"
          extra={{ gap_id: gap.id, status: "excluded" }}
          confirmLabel="Exclude"
        >
          <label className="grid gap-1 text-[12px] text-muted-foreground">
            Exclusion reason
            <select
              name="exclusion_reason"
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
              defaultValue={gap.exclusion_reason ?? "not_defined"}
              required
            >
              {EXCLUSION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {EXCLUSION_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </LockForm>
      )}
    </AppShell>
  );
}
