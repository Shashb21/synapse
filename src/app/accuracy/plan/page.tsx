import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { PlanIdeateAllButton, PlanPriorityCard } from "@/components/accuracy/plan-priority-card";
import { WorkshopSaveCta } from "@/components/accuracy/workshop-save-cta";
import { registerAccuracyStack } from "@/accuracy";
import {
  gapsEligibleForIdeation,
  resolveGapStatus,
  resolvePriorityBand,
} from "@/accuracy/domain/iegp-semantics";
import { claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { listWorkspaces } from "@/accuracy/store/tenant";
import { latestWorkshopSnapshot, workshopReadiness } from "@/accuracy/store/workshop-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let gaps: Awaited<ReturnType<typeof listClaims>> = [];
  let loadError: string | null = null;
  let ready: Awaited<ReturnType<typeof workshopReadiness>>["readiness"] | null = null;
  let hasSnapshot = false;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      gaps = await listClaims(workspaceId, { claim_type: "gap", limit: 200 });
      const workshop = await workshopReadiness(workspaceId);
      ready = workshop.readiness;
      hasSnapshot = Boolean(await latestWorkshopSnapshot(workspaceId));
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load plan";
  }

  const active = workspaces.find((w) => w.id === workspaceId);
  const eligibleCount = gapsEligibleForIdeation(
    gaps.map((gap) => {
      const meta = claimMetadata(gap);
      return {
        id: gap.id,
        priority_band: resolvePriorityBand(meta.priority ?? meta.priority_band),
        status: resolveGapStatus(gap.status),
        validated: gap.validated,
      };
    }),
  ).length;

  return (
    <AccuracyAppShell active="plan">
      <PageIntro kicker="Prioritize · H / M / L bands" title="Plan">
        Set priority bands on evidence gaps. Validated high-priority open gaps can run live LLM
        ideation — origin ideated, status proposed until you validate. Inventory tactics stay on
        extract.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <p className="text-[12px] text-muted-foreground">
          Open from{" "}
          <Link href="/accuracy" className="underline-offset-2 hover:underline">
            Workspaces
          </Link>
          .
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · {active?.name ?? workspaceId} · {gaps.length} gap(s) · {eligibleCount} high
            open eligible for ideate · edit proposed tactics (name, type, design, dates) on the{" "}
            <Link
              href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
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
              workshopHref={`/accuracy/workshop?workspace_id=${encodeURIComponent(workspaceId)}`}
            />
          ) : null}
          {gaps.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No gaps yet — seed gold or extract needs.</p>
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
                    validated={gap.validated}
                    status={gap.status}
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
