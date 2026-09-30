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

  // One screen (owner feedback, KAN-56): no setting picker step; All settings until one is chosen.
  const scope = tags.find((tag) => tag.toLowerCase() === setting?.toLowerCase()) ?? ALL_SETTINGS_SCOPE;
  const unlockTactics =
    !state.asset.tactics_unlocked && allCounts.open > 0 && allCounts.validated === allCounts.open ? (
      <LockForm label="Continue to tactics" action="unlock_tactics" confirmLabel="Go to tactics" variant="default" />
    ) : null;

  const footer = (
    <>
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

  const scopeLabel = scope === ALL_SETTINGS_SCOPE ? "all settings" : scope;
  const scopeGaps = openGaps.filter((gap) => gapInSetting(gap, scope));
  const scopeAxes = await loadScopeAxes(scope);
  // A scope without saved axes starts on the default pair; the axis pickers above the matrix change them.
  const xAxis = catalog.axes.find((axis) => axis.id === (scopeAxes?.x_axis ?? catalog.x_axis));
  const yAxis = catalog.axes.find((axis) => axis.id === (scopeAxes?.y_axis ?? catalog.y_axis));

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
      <section
        className="mb-4 grid gap-3 rounded-lg border border-border bg-card p-3"
        aria-label="Prioritization controls"
        data-testid="prioritize-toolbar"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Setting</span>
          <nav className="flex flex-wrap items-center gap-1" aria-label="Setting">
            {[ALL_SETTINGS_SCOPE, ...tags].map((tag) => {
              const active = tag === scope;
              const inScope = tag === ALL_SETTINGS_SCOPE ? openGaps : openGaps.filter((gap) => gapInSetting(gap, tag));
              return (
                <Link
                  key={tag}
                  href={scopeHref(tag)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-medium no-underline",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tag === ALL_SETTINGS_SCOPE ? "All settings" : tag}
                  <span className={cn("text-[10px]", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {validatedIn(inScope)}/{inScope.length}
                  </span>
                </Link>
              );
            })}
          </nav>
          {tags.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">
              Tag treatment settings on{" "}
              <Link href="/?place=gaps" className="text-foreground">
                Evidence Inventory
              </Link>{" "}
              to prioritize one setting at a time.
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-foreground">
              {allCounts.validated} of {allCounts.open} Open gaps validated across all settings
            </p>
            <p className="text-[11px] text-muted-foreground">
              {state.asset.tactics_unlocked
                ? "Tactics is unlocked. You can keep adjusting priorities here."
                : allCounts.validated === allCounts.open && allCounts.open > 0
                  ? "Every Open gap has a validated priority."
                  : "Drag each gap to its place, then validate its priority to continue to Tactics."}
            </p>
          </div>
          {unlockTactics}
        </div>
      </section>
      {scopeGaps.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No Open gap in {scopeLabel}.</p>
      ) : xAxis && yAxis ? (
        <PrioritizeMatrix
          key={`${scope}:${xAxis.id}:${yAxis.id}`}
          scope={scope}
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
