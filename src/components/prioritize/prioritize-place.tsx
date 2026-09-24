import Link from "next/link";
import { LockForm } from "@/components/lock-form";
import { GapPlanCard } from "@/components/plan-cards";
import { AxisChooser, PrioritizeMatrix, type PrioritizeGap } from "@/components/prioritize/prioritize-matrix";
import type { Band } from "@/components/matrix/bands";
import { cn } from "@/lib/utils";
import {
  displayedGapStatus,
  gapInSetting,
  isLiveGap,
  mappedTactics,
  settingOptions,
  type PlanGapCard,
} from "@/lib/iegp/engine";
import { DOMAIN_LABELS } from "@/lib/iegp/enums";
import type { IegpState } from "@/lib/iegp/types";
import { can } from "@/modules/auth/roles";
import { sessionContext } from "@/modules/auth/session";
import { ALL_SETTINGS_SCOPE, loadAxes, loadScopeAxes } from "@/modules/stages/s8-prioritization/axes";
import { listPlacements } from "@/modules/stages/s8-prioritization/module";

function scopeHref(scope: string) {
  return `/?place=plan&setting=${encodeURIComponent(scope)}`;
}

function SettingPicker({
  options,
  counts,
  untagged,
}: {
  options: { scope: string; label: string; open: number; validated: number }[];
  counts: { open: number; validated: number };
  untagged: number;
}) {
  return (
    <section className="grid gap-4" aria-labelledby="choose-setting">
      <div>
        <h2 id="choose-setting" className="text-[15px] font-medium text-foreground">
          Choose a setting to prioritize
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Each setting gets its own matrix and axes. A gap tagged with several settings keeps one
          priority across all of them.
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((option) => (
          <li key={option.scope}>
            <Link
              href={scopeHref(option.scope)}
              className="grid gap-1 border border-border bg-card/40 p-4 no-underline transition-colors hover:bg-card"
            >
              <span className="text-[14px] font-medium text-foreground">{option.label}</span>
              <span className="text-[12px] text-muted-foreground">
                {option.open} Open gap{option.open === 1 ? "" : "s"} · {option.validated} validated
              </span>
            </Link>
          </li>
        ))}
        <li>
          <Link
            href={scopeHref(ALL_SETTINGS_SCOPE)}
            className="grid gap-1 border border-dashed border-border bg-card/20 p-4 no-underline transition-colors hover:bg-card"
          >
            <span className="text-[14px] font-medium text-foreground">All settings</span>
            <span className="text-[12px] text-muted-foreground">
              Every Open gap · {counts.open} total · {counts.validated} validated
            </span>
          </Link>
        </li>
      </ul>
      {options.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No gap is tagged with a setting yet. Tag settings on{" "}
          <Link href="/?place=gaps" className="text-foreground no-underline hover:underline">
            Gaps
          </Link>{" "}
          to prioritize one setting at a time, or prioritize across all settings.
        </p>
      ) : untagged > 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {untagged} Open gap{untagged === 1 ? " has" : "s have"} no setting and only appear under
          All settings.{" "}
          <Link href="/?place=gaps" className="text-foreground no-underline hover:underline">
            Tag them on Gaps
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/**
 * Prioritize: pick a treatment setting (or all), pick two axes, and the model
 * places that scope's Open gaps on the matrix for the user to drag and validate.
 */
export async function PrioritizePlace({
  state,
  setting,
  addressed,
  availableTactics,
}: {
  state: IegpState;
  setting: string | undefined;
  addressed: PlanGapCard[];
  availableTactics: Parameters<typeof GapPlanCard>[0]["availableTactics"];
}) {
  const [placements, catalog, session] = await Promise.all([
    listPlacements(),
    loadAxes(),
    sessionContext(),
  ]);
  const identity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };
  const mayPrioritize = can(session.role, "prioritize");
  const placementByGap = new Map(placements.map((row) => [row.gap_id, row]));

  const openGaps = state.gaps.filter(
    (gap) => isLiveGap(gap) && displayedGapStatus(gap) === "validated_open",
  );
  const validatedIn = (gaps: typeof openGaps) =>
    gaps.filter((gap) => placementByGap.get(gap.id)?.validated).length;
  const tags = settingOptions({ gaps: openGaps });
  const allCounts = { open: openGaps.length, validated: validatedIn(openGaps) };

  const scope =
    setting === ALL_SETTINGS_SCOPE
      ? ALL_SETTINGS_SCOPE
      : tags.find((tag) => tag.toLowerCase() === setting?.toLowerCase());
  const unlockTactics =
    !state.asset.tactics_unlocked && allCounts.open > 0 && allCounts.validated === allCounts.open ? (
      <LockForm label="Continue to tactics" action="unlock_tactics" confirmLabel="Go to tactics" variant="default" />
    ) : null;

  const footer = (
    <>
      <div className="mt-8 flex flex-wrap items-center gap-3 border border-border bg-card/40 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-medium text-foreground">
            {allCounts.validated} of {allCounts.open} Open gaps validated across all settings
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {state.asset.tactics_unlocked
              ? "Tactics is unlocked. You can keep adjusting priorities here."
              : allCounts.validated === allCounts.open && allCounts.open > 0
                ? "Every Open gap has a validated band."
                : "Validate every Open gap's band to continue to Tactics."}
          </p>
        </div>
        {unlockTactics}
      </div>
      <details className="group mt-6">
        <summary className="cursor-pointer list-none text-[13px] font-medium text-foreground marker:content-none">
          Addressed
          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
            ({addressed.length}) · not prioritized · click to expand
          </span>
        </summary>
        {addressed.length === 0 ? (
          <p className="mt-2 text-[12px] text-muted-foreground">No addressed gaps yet.</p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {addressed.map((card) => (
              <GapPlanCard key={card.gap_id} card={card} availableTactics={availableTactics} />
            ))}
          </div>
        )}
      </details>
    </>
  );

  if (!scope) {
    return (
      <>
        <SettingPicker
          options={tags.map((tag) => {
            const inScope = openGaps.filter((gap) => gapInSetting(gap, tag));
            return { scope: tag, label: tag, open: inScope.length, validated: validatedIn(inScope) };
          })}
          counts={allCounts}
          untagged={openGaps.filter((gap) => (gap.settings ?? []).length === 0).length}
        />
        {footer}
      </>
    );
  }

  const scopeLabel = scope === ALL_SETTINGS_SCOPE ? "all settings" : scope;
  const scopeGaps = openGaps.filter((gap) => gapInSetting(gap, scope));
  const scopeAxes = await loadScopeAxes(scope);
  const xAxis = catalog.axes.find((axis) => axis.id === scopeAxes?.x_axis);
  const yAxis = catalog.axes.find((axis) => axis.id === scopeAxes?.y_axis);

  const cards: PrioritizeGap[] = scopeGaps.map((gap) => {
    const placement = placementByGap.get(gap.id);
    return {
      gap_id: gap.id,
      gap_name: gap.name,
      statement: gap.statement,
      domain_label: DOMAIN_LABELS[gap.domain],
      settings: gap.settings ?? [],
      tactic_count: mappedTactics(state, gap.id).length,
      axis_scores: placement?.axis_scores ?? null,
      band: (placement?.band ?? null) as Band | null,
      validated: placement?.validated ?? false,
      suggested_band: (placement?.suggested_band ?? null) as Band | null,
      suggested_rationale: placement?.suggested_rationale ?? null,
      human_axes: placement?.human_axes ?? [],
      human_band: placement?.human_band ?? false,
      rationale: placement?.rationale ?? null,
      actor_name: placement?.actor_name ?? null,
      at: placement?.at ?? null,
    };
  });

  return (
    <>
      <nav className="mb-4 flex flex-wrap items-center gap-1.5" aria-label="Setting">
        <Link href="/?place=plan" className="mr-1 text-[12px] text-muted-foreground no-underline hover:underline">
          ← Settings
        </Link>
        {[...tags, ALL_SETTINGS_SCOPE].map((tag) => {
          const active = tag === scope;
          return (
            <Link
              key={tag}
              href={scopeHref(tag)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[12px] no-underline",
                active
                  ? "border-foreground/40 bg-muted text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {tag === ALL_SETTINGS_SCOPE ? "All settings" : tag}
            </Link>
          );
        })}
      </nav>
      {scopeGaps.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No Open gap in {scopeLabel}.</p>
      ) : xAxis && yAxis ? (
        <PrioritizeMatrix
          key={`${scope}:${xAxis.id}:${yAxis.id}`}
          scope={scope}
          scopeLabel={scopeLabel}
          gaps={cards}
          axes={catalog.axes}
          xAxis={xAxis}
          yAxis={yAxis}
          identity={identity}
          mayPrioritize={mayPrioritize}
        />
      ) : (
        <AxisChooser
          scope={scope}
          scopeLabel={scopeLabel}
          axes={catalog.axes}
          gapIds={scopeGaps.map((gap) => gap.id)}
          identity={identity}
          mayPrioritize={mayPrioritize}
          submitLabel="Prioritize"
        />
      )}
      {footer}
    </>
  );
}
