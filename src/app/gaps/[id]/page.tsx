import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageIntro } from "@/components/app-shell";
import { CoverageBadge, GapBadge, LockMeta, StaleFlag } from "@/components/iegp-badges";
import { LockForm } from "@/components/lock-form";
import {
  COVERAGE_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_QUESTIONS,
  DIMENSION_VALUES,
  EXCLUSION_LABELS,
  EXCLUSION_REASONS,
  GAP_STATUSES,
  GAP_STATUS_LABELS,
  OVERALL_COVERAGE,
} from "@/lib/iegp/enums";
import { loadState } from "@/lib/iegp/store";
import { suggestGapStatus, suggestResidualGaps, uncoveredDimensions } from "@/lib/iegp/engine";

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
  const suggested = suggestGapStatus(coverages, state.tactics);
  const missing = uncoveredDimensions(coverages);
  const leftover = suggestResidualGaps(state).find((row) => row.parent_gap_id === gap.id);
  const children = state.gaps.filter((g) => g.parent_gap_id === gap.id);
  const parent = gap.parent_gap_id
    ? state.gaps.find((g) => g.id === gap.parent_gap_id)
    : undefined;

  return (
    <AppShell active="gaps">
      <PageIntro kicker={gap.id} title={gap.name} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <GapBadge status={gap.status} />
        <LockMeta lock={gap.status_lock} />
        <span className="text-[12px] text-muted-foreground">
          Engine suggests {GAP_STATUS_LABELS[suggested]} (never auto-applied)
        </span>
      </div>

      <section className="mb-8">
        <h2 className="mb-2 text-[13px] text-muted-foreground">Constituent needs</h2>
        <div className="grid gap-2">
          {needs.map(({ need, link }) => (
            <p key={need.id} className="border border-border bg-card p-3 text-[13px]">
              <span className="text-[11px] text-muted-foreground">{link.role} · {need.id}</span>
              <br />
              {need.statement}
            </p>
          ))}
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
        {coverages.map((c) => {
          const tactic = state.tactics.find((t) => t.id === c.tactic_id);
          return (
            <article key={c.id} className="mb-4 border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/tactics/${c.tactic_id}`} className="text-[13px] text-foreground">
                  {tactic?.name}
                </Link>
                <CoverageBadge overall={c.overall} />
                <StaleFlag stale={c.stale} />
              </div>
              <p className="mt-2 text-[12px] text-muted-foreground">{c.overall_rationale}</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="py-1 font-medium">Dimension</th>
                      <th className="py-1 font-medium">Assessment</th>
                      <th className="py-1 font-medium">Lock</th>
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
                              label="Lock dimension"
                              action="lock_dimension"
                              extra={{ coverage_id: c.id, dimension: dim }}
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
                  label="Lock overall coverage"
                  action="lock_overall"
                  extra={{ coverage_id: c.id }}
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

      {leftover ? (
        <section className="mb-8 border border-border bg-card p-4">
          <h2 className="text-[13px] text-muted-foreground">Residual evidence need</h2>
          <p className="mt-2 text-[13px] text-foreground">{leftover.statement}</p>
          <ul className="mt-2 grid gap-1">
            {leftover.reasons.map((reason) => (
              <li key={reason} className="text-[12px] leading-5 text-muted-foreground">
                {reason}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <LockForm
              label="Accept as new gap"
              action="accept_residual_gap"
              extra={{ parent_gap_id: leftover.parent_gap_id, statement: leftover.statement }}
              confirmLabel="Accept as new gap"
            />
            <LockForm
              label="Reject leftover"
              action="reject_residual_gap"
              extra={{ parent_gap_id: leftover.parent_gap_id }}
              confirmLabel="Reject leftover"
            />
          </div>
        </section>
      ) : null}

      <LockForm label="Lock gap status" action="lock_gap" extra={{ gap_id: gap.id }}>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Status
          <select
            name="status"
            defaultValue={gap.status}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
          >
            {GAP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {GAP_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[12px] text-muted-foreground">
          Exclusion reason (if excluded)
          <select
            name="exclusion_reason"
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground"
            defaultValue={gap.exclusion_reason ?? ""}
          >
            <option value="">—</option>
            {EXCLUSION_REASONS.map((r) => (
              <option key={r} value={r}>
                {EXCLUSION_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </LockForm>
    </AppShell>
  );
}
