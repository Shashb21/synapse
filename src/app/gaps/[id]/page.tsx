import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { CoverageBadge, GapBadge, LockMeta, NeedsReviewFlag, ParkedFlag } from "@/components/iegp-badges";
import { CoverageDimensionsMenu } from "@/components/coverage-dimensions-menu";
import { LockForm } from "@/components/lock-form";
import { Textarea } from "@/components/ui/textarea";
import { MapExistingTactic, RecordMissedTactic } from "@/components/gap-tactic-actions";
import { AssignTacticWithCoverage, UnassignTactic } from "@/components/assign-tactic-with-coverage";
import { GapStatusDisagreement, GapStatusOverride } from "@/components/gap-status-override";
import { SplitGapDialog } from "@/components/split-gap-dialog";
import { ActionDialog, type ActionIdentity } from "@/components/platform/action-dialog";
import { sessionContext } from "@/modules/auth/session";
import {
  DOMAIN_LABELS,
  EVIDENCE_DOMAINS,
  COVERAGE_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_QUESTIONS,
  DIMENSION_VALUES,
  EXCLUSION_LABELS,
  EXCLUSION_REASONS,
  GAP_STATUS_DEFINITIONS,
  GAP_STATUS_LABELS,
  ASSESSED_COVERAGE,
} from "@/lib/iegp/enums";
import { loadState, ensureGapHasConstituentNeed } from "@/lib/iegp/store";
import {
  buildTacticLibrary,
  computeGapStatus,
  coverageDimensionValues,
  displayedGapStatus,
  liveGapsMappedToTactic,
  mappedTactics,
  persistedResidualGaps,
} from "@/lib/iegp/engine";

export const dynamic = "force-dynamic";

export default async function GapDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await ensureGapHasConstituentNeed(id);
  const [state, session] = await Promise.all([loadState(), sessionContext()]);
  const identity: ActionIdentity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };
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
  // Only a leftover a person saved is shown; drafts come from S6 on demand.
  const leftover = persistedResidualGaps(state).find((row) => row.parent_gap_id === gap.id);
  const tactics = mappedTactics(state, gap.id);
  const library = buildTacticLibrary(state);
  const parent = gap.parent_gap_id
    ? state.gaps.find((g) => g.id === gap.parent_gap_id)
    : undefined;

  const mapped =
    shown === "validated_open" || shown === "validated_partial" || shown === "validated_addressed";
  // Gaps a need can move onto: every gap still on record except this one.
  const moveTargets = [
    ...state.gaps
      .filter((g) => g.id !== gap.id && !g.retired)
      .map((g) => ({ value: g.id, label: `${g.id} · ${g.name}` })),
    { value: "__new__", label: "A new gap made from this need" },
  ];

  return (
    <AppShell active="gaps">
      <PageIntro kicker={gap.id} title={gap.name} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {shown === "validated_partial" ? (
          <>
            <GapBadge status={shown} />
            <SplitGapDialog
              gapId={gap.id}
              gapName={gap.name}
              residualName={leftover?.statement || gap.name}
              tactics={tactics}
            />
          </>
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
        {gap.parked_at ? <ParkedFlag reason={gap.parked_reason} /> : null}
        {mapped && !gap.status_override ? (
          <span className="text-[11px] text-muted-foreground">
            Engine computed {GAP_STATUS_LABELS[computed]}
          </span>
        ) : (
          <LockMeta lock={gap.status_lock} />
        )}
      </div>
      <GapStatusDisagreement computedStatus={computed} override={gap.status_override} />
      <div className="mb-4 border border-border bg-card/40 p-3">
        <p className="text-[13px] leading-5 text-foreground">{gap.statement}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{DOMAIN_LABELS[gap.domain]}</span>
          {gap.retired ? null : (
            <ActionDialog
              endpoint="/api/iegp"
              payload={{ action: "modify_gap", gap_id: gap.id }}
              identity={identity}
              label="Edit gap"
              title={`Edit ${gap.id}`}
              description="Your wording replaces the current name, statement and domain. It is locked to you and kept on every later AI run; the AI only adds needs to a gap, it never rewrites one."
              confirmLabel="Save edit"
              fields={[
                { name: "name", label: "Name", defaultValue: gap.name, required: true },
                { name: "statement", label: "Statement", type: "textarea", defaultValue: gap.statement, required: true },
                {
                  name: "domain",
                  label: "Domain",
                  type: "select",
                  defaultValue: gap.domain,
                  options: EVIDENCE_DOMAINS.map((domain) => ({ value: domain, label: DOMAIN_LABELS[domain] })),
                },
              ]}
            />
          )}
        </div>
      </div>
      <p className="mb-6 text-[12px] leading-5 text-muted-foreground">
        {GAP_STATUS_DEFINITIONS[shown]}{" "}
        {shown === "validated_partial"
          ? "Click Partially Addressed to split (Addressed + tactic on the left, Open leftover on the right) or rewrite the original. Partial cannot stay."
          : "Click Open or Addressed to override with a required reason. Cancel does not change status."}
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-[13px] text-muted-foreground">Constituent needs — sources</h2>
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          Where this gap comes from. Constituent needs are the sourced statements extracted from
          documents or interviews. If the same gap was identified in several sources, every source
          is listed. Role is primary or supporting. If the AI joined a need onto the wrong gap,
          move it to the right one (or to a new gap); later runs never re-link it.
        </p>
        {gap.retired ? null : (
          <div className="mb-3">
            <ActionDialog
              endpoint="/api/iegp"
              payload={{ action: "create_need", gap_id: gap.id }}
              identity={identity}
              label="Add need"
              description="Record a need by hand, e.g. from a meeting no uploaded source covers. Pick its source if it came from an ingested document."
              confirmLabel="Add need"
              fields={[
                { name: "statement", label: "Need statement", type: "textarea", required: true },
                { name: "source_quote", label: "Source quote (optional)", type: "textarea" },
                {
                  name: "source_id",
                  label: "Source",
                  type: "select",
                  defaultValue: "",
                  options: [
                    { value: "", label: "Recorded by hand (no source file)" },
                    ...state.sources.map((s) => ({ value: s.id, label: s.title })),
                  ],
                },
              ]}
            />
          </div>
        )}
        <div className="grid gap-2">
          {needs.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No constituent needs yet.</p>
          ) : (
            needs.map(({ need, link }) => {
              const source = state.sources.find((s) => s.id === need.source_id);
              return (
                <div key={need.id} className="border border-border bg-card p-3 text-[13px]">
                  <span className="text-[11px] capitalize text-muted-foreground">
                    {link.role} · {source?.title || need.source_id} · {need.id}
                  </span>
                  <p className="mt-1">{need.statement}</p>
                  {need.source_quote && need.source_quote !== need.statement ? (
                    <p className="mt-1 text-[12px] text-muted-foreground">“{need.source_quote}”</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ActionDialog
                      endpoint="/api/iegp"
                      payload={{ action: "edit_need", need_id: need.id }}
                      identity={identity}
                      label="Edit need"
                      description="Correct the need's wording or its source quote. The edit is locked to you and kept on later AI runs."
                      confirmLabel="Save edit"
                      fields={[
                        { name: "statement", label: "Statement", type: "textarea", defaultValue: need.statement, required: true },
                        { name: "source_quote", label: "Source quote", type: "textarea", defaultValue: need.source_quote },
                      ]}
                    />
                    <ActionDialog
                      endpoint="/api/iegp"
                      payload={{ action: "move_need", need_id: need.id, from_gap_id: gap.id }}
                      identity={identity}
                      label="Move to another gap"
                      description="Moves this need off this gap. Use it when the AI merged a need into the wrong gap."
                      confirmLabel="Move need"
                      fields={[
                        {
                          name: "to_gap_id",
                          label: "Move onto",
                          type: "select",
                          defaultValue: moveTargets[0]?.value,
                          options: moveTargets,
                          required: true,
                        },
                        {
                          name: "new_gap_name",
                          label: "Name for the new gap (only when moving to a new gap)",
                          placeholder: "Blank: derived from the need",
                        },
                      ]}
                    />
                    {needs.length > 1 ? (
                      <ActionDialog
                        endpoint="/api/iegp"
                        payload={{ action: "unlink_need", need_id: need.id, gap_id: gap.id }}
                        identity={identity}
                        label="Unlink"
                        description="Removes this need from this gap. The need itself stays on the Needs page."
                        confirmLabel="Unlink need"
                      />
                    ) : null}
                  </div>
                </div>
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
          Each row shows the recorded coverage verdict (S4 model or a person) and its ten
          dimensions. A tactic existing is not coverage. A publication existing is not coverage.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <MapExistingTactic
            gapId={gap.id}
            availableTactics={library}
            mappedTacticIds={coverages.map((c) => c.tactic_id)}
          />
          <AssignTacticWithCoverage
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
                <NeedsReviewFlag needsReview={c.needs_review} />
                <CoverageDimensionsMenu
                  overall={c.overall}
                  dimensions={coverageDimensionValues(c.dimensions)}
                />
                <UnassignTactic gapId={gap.id} tacticId={c.tactic_id} />
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
                              {cell.rationale ? (
                                <p className="text-[11px] text-muted-foreground">
                                  Current rationale: {cell.rationale}
                                </p>
                              ) : null}
                              <label className="grid gap-1 text-[12px] text-muted-foreground">
                                Your rationale (required)
                                <textarea
                                  name="rationale"
                                  required
                                  minLength={3}
                                  placeholder="Why this dimension has this value"
                                  className="min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
                                />
                              </label>
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
                      {ASSESSED_COVERAGE.map((v) => (
                        <option key={v} value={v}>
                          {v.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  {c.overall_rationale ? (
                    <p className="text-[11px] text-muted-foreground">
                      Current rationale: {c.overall_rationale}
                    </p>
                  ) : null}
                  <label className="grid gap-1 text-[12px] text-muted-foreground">
                    Your rationale (required)
                    <textarea
                      name="rationale"
                      required
                      minLength={3}
                      placeholder="Why this tactic covers the gap this much"
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

      {shown === "validated_partial" ? (
        <section className="mb-8 border border-border bg-card p-4">
          <h2 className="text-[13px] text-muted-foreground">Leftover (right side of split)</h2>
          {leftover ? (
            <>
              <p className="mt-2 text-[13px] text-foreground">{leftover.statement}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <ActionDialog
                  endpoint="/api/iegp"
                  payload={{ action: "accept_residual_gap", parent_gap_id: gap.id }}
                  identity={identity}
                  label="Accept as new gap"
                  variant="default"
                  description="Creates the leftover as a new Open gap and locks this gap as Addressed. You can adjust the wording first."
                  confirmLabel="Accept leftover"
                  fields={[
                    { name: "statement", label: "Leftover statement", type: "textarea", defaultValue: leftover.statement, required: true },
                  ]}
                />
                <ActionDialog
                  endpoint="/api/iegp"
                  payload={{ action: "modify_residual_gap", parent_gap_id: gap.id }}
                  identity={identity}
                  label="Edit leftover"
                  description="Saves your wording as the leftover draft. Nothing is created until you accept it."
                  confirmLabel="Save leftover"
                  fields={[
                    { name: "statement", label: "Leftover statement", type: "textarea", defaultValue: leftover.statement, required: true },
                  ]}
                />
                <ActionDialog
                  endpoint="/api/iegp"
                  payload={{ action: "reject_residual_gap", parent_gap_id: gap.id }}
                  identity={identity}
                  label="Reject leftover"
                  description="Rejects this leftover. It will not be suggested again for this gap."
                  confirmLabel="Reject leftover"
                />
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                No leftover drafted. Open Partially Addressed and use &ldquo;Suggest a split&rdquo; to
                have the S6 model propose the addressed slice and the open leftover, or write the
                leftover yourself.
              </p>
              <div className="mt-3">
                <ActionDialog
                  endpoint="/api/iegp"
                  payload={{ action: "modify_residual_gap", parent_gap_id: gap.id }}
                  identity={identity}
                  label="Write leftover"
                  description="Saves your leftover as a draft on this gap. Accept it afterwards to create the new Open gap."
                  confirmLabel="Save leftover"
                  fields={[
                    { name: "statement", label: "Leftover statement", type: "textarea", required: true },
                  ]}
                />
              </div>
            </>
          )}
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

      {gap.retired || gap.status === "excluded" ? null : gap.parked_at ? (
        <section className="mb-8 flex flex-wrap items-center justify-between gap-3 border border-fuchsia-500/30 bg-fuchsia-500/10 p-4">
          <div>
            <p className="text-[12px] text-foreground">
              Parked{gap.parked_reason ? `: ${gap.parked_reason}` : ""}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Hidden from Prioritize and Tactics mapping while parked. Unpark to bring it back.
            </p>
          </div>
          <LockForm
            label="Unpark gap"
            action="unpark_gap"
            extra={{ gap_id: gap.id }}
            confirmLabel="Unpark"
            description="This brings the gap back into Prioritize and Tactics mapping."
          />
        </section>
      ) : (
        <section className="mb-8 flex flex-wrap items-center gap-3 border border-border bg-card/40 p-4">
          <p className="flex-1 text-[12px] text-muted-foreground">
            Not sure this is a real gap yet? Park it instead of excluding it — parked gaps stay
            listed but drop out of Prioritize and Tactics until you unpark them.
          </p>
          <LockForm
            label="Park gap"
            action="park_gap"
            extra={{ gap_id: gap.id }}
            confirmLabel="Park"
            description="Set this gap aside if you don't think it's a real evidence gap. A reason is required. Parked gaps can be unparked later."
          >
            <label className="grid gap-1 text-[12px] text-muted-foreground">
              Reason
              <Textarea name="reason" rows={2} required />
            </label>
          </LockForm>
        </section>
      )}

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
