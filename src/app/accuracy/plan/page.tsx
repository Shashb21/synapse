import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { PlanPriorityCard } from "@/components/accuracy/plan-priority-card";
import { registerAccuracyStack } from "@/accuracy";
import { claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { listWorkspaces } from "@/accuracy/store/tenant";

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

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      gaps = await listClaims(workspaceId, { claim_type: "gap", limit: 200 });
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load plan";
  }

  const active = workspaces.find((w) => w.id === workspaceId);

  return (
    <AccuracyAppShell active="plan">
      <PageIntro kicker="Prioritize · H / M / L bands" title="Plan">
        Set priority bands on evidence gaps. Validated high-priority gaps unlock net-new tactic
        ideation (mechanical stub until an LLM route is connected).
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
            Workspace · {active?.name ?? workspaceId} · {gaps.length} gap(s)
          </p>
          {gaps.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No gaps yet — seed gold or extract needs.</p>
          ) : (
            <div className="grid gap-2">
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
