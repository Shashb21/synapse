import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { PlanIdeateAllButton, PlanPriorityCard } from "@/components/accuracy/plan-priority-card";
import { WorkshopSaveCta } from "@/components/accuracy/workshop-save-cta";
import { registerAccuracyStack } from "@/accuracy";
import {
  gapsEligibleForIdeation,
  resolvePriorityBand,
} from "@/accuracy/domain/iegp-semantics";
import { claimMetadata, isActiveLedgerClaim, listDownstreamClaims } from "@/accuracy/store/claim-store";
import { claimValidationFreshness } from "@/accuracy/domain/structured-fields";
import { listCoverageJoins } from "@/accuracy/store/coverage-store";
import { asTacticLifecycle, deriveWorkspaceGapStatuses, gapStatusSchema, type GapStatus } from "@/accuracy/modules/status-derive/engine";
import { workspacePlanLabel } from "@/accuracy/domain/plan-label";
import { getWorkspace } from "@/accuracy/store/tenant";
import { UnknownWorkspaceNotice, workspaceLabel } from "@/components/accuracy/unknown-workspace";
import { latestWorkshopSnapshot, workshopReadiness } from "@/accuracy/store/workshop-store";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  await requireOwnerPage();
  const { workspace_id: workspaceId = "" } = await searchParams;
  let active: Awaited<ReturnType<typeof getWorkspace>> = null;
  let gaps: Awaited<ReturnType<typeof listDownstreamClaims>> = [];
  let statuses = new Map<string, GapStatus>();
  let loadError: string | null = null;
  let ready: Awaited<ReturnType<typeof workshopReadiness>>["readiness"] | null = null;
  let hasSnapshot = false;
  const aiOn = await aiEnabled();

  try {
    if (workspaceId) active = await getWorkspace(workspaceId);
    if (active) {
      const claims = await listDownstreamClaims(workspaceId, { limit: null });
      gaps = claims.filter(claim => claim.claim_type === "gap" && isActiveLedgerClaim(claim));
      const coverages = await listCoverageJoins(workspaceId, { effective: true });
      statuses = new Map(deriveWorkspaceGapStatuses({
        gap_ids: gaps.map(gap => gap.id), coverages,
        tactics: claims.filter(claim => claim.claim_type === "tactic" && isActiveLedgerClaim(claim)).map(claim => ({ id: claim.id,
          status: asTacticLifecycle(claimMetadata(claim).tactic_status) ?? asTacticLifecycle(claim.status) ?? "unknown" })),
        overrides: Object.fromEntries(gaps.map(gap => [gap.id, gapStatusSchema.safeParse(claimMetadata(gap).status_override?.status).data ?? null])),
      }).map(row => [row.gap_id, row.status]));
      const workshop = await workshopReadiness(workspaceId);
      ready = workshop.readiness;
      hasSnapshot = Boolean(await latestWorkshopSnapshot(workspaceId));
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load plan";
  }

  const unknownWorkspace = Boolean(workspaceId) && !active && !loadError;
  const eligibleCount = gapsEligibleForIdeation(
    gaps.map((gap) => {
      const meta = claimMetadata(gap);
      return {
        id: gap.id,
        priority_band: resolvePriorityBand(meta.priority ?? meta.priority_band),
        status: statuses.get(gap.id) ?? "open",
        validated: claimValidationFreshness(gap) === "current",
      };
    }),
  ).length;

  return (
    <AccuracyAppShell active="plan" planLabel={workspacePlanLabel(active)}>
      <PageIntro kicker="Prioritize · High / Medium / Low / Defer" title="Plan">
        {aiOn
          ? "Set priority bands on evidence gaps. Validated high-priority open gaps can run live LLM ideation — origin ideated, status proposed until you validate. Inventory tactics stay on extract."
          : "Set priority bands on evidence gaps. AI is off: for validated high-priority open gaps, write proposed tactics by hand — status proposed until you validate."}
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card p-2 text-[12px] text-destructive rounded-lg">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <p className="text-[12px] text-muted-foreground">
          Open from{" "}
          <Link href="/admin/accuracy" className="underline-offset-2 hover:underline">
            Workspaces
          </Link>
          .
        </p>
      ) : unknownWorkspace ? (
        <UnknownWorkspaceNotice workspaceId={workspaceId} />
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · {active ? workspaceLabel(active) : workspaceId} · {gaps.length} gap(s) · {eligibleCount} high
            open eligible for {aiOn ? "ideate" : "a proposed tactic"} · edit proposed tactics (name, type, design, dates) on the{" "}
            <Link
              href={`/admin/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
              className="text-foreground underline-offset-2 hover:underline"
            >
              Ledger
            </Link>
          </p>
          {ready ? (
            <WorkshopSaveCta
              workspaceId={workspaceId}
              ready={ready.ready}
              blockers={ready.blockers}
              hasSnapshot={hasSnapshot}
              workshopHref={`/admin/accuracy/workshop?workspace_id=${encodeURIComponent(workspaceId)}`}
            />
          ) : null}
          {gaps.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{aiOn ? "No gaps yet — seed gold or extract needs." : "No gaps yet — add them by hand on the Ledger."}</p>
          ) : (
            <div className="grid gap-2">
              <PlanIdeateAllButton workspaceId={workspaceId} eligibleCount={eligibleCount} />
              {gaps.map((gap) => {
                const meta = claimMetadata(gap);
                const priority =
                  typeof meta.priority === "string"
                    ? meta.priority
                    : typeof meta.priority_band === "string"
                      ? meta.priority_band
                      : null;
                return (
                  <PlanPriorityCard
                    key={gap.id}
                    workspaceId={workspaceId}
                    claimId={gap.id}
                    statement={gap.statement}
                    priority={priority}
                    validated={claimValidationFreshness(gap) === "current"}
                    status={statuses.get(gap.id) ?? "open"}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </AccuracyAppShell>
  );
}
