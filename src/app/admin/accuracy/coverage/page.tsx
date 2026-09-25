import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { CoverageQueue } from "@/components/accuracy/coverage-queue";
import { CoverageManualPairForm } from "@/components/accuracy/coverage-manual-pair-form";
import { isActiveLedgerClaim, listClaims } from "@/accuracy/store/claim-store";
import { WorkshopSaveCta } from "@/components/accuracy/workshop-save-cta";
import { registerAccuracyStack } from "@/accuracy";
import { listCoveragePairs } from "@/accuracy/store/coverage-store";
import { buildCoverageQueue } from "@/accuracy/store/coverage-queue";
import { listWorkspaces } from "@/accuracy/store/tenant";
import { latestWorkshopSnapshot, workshopReadiness } from "@/accuracy/store/workshop-store";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  await requireOwnerPage();
  const { workspace_id: workspaceId = "" } = await searchParams;
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let pairs: Awaited<ReturnType<typeof listCoveragePairs>> = [];
  let loadError: string | null = null;
  let gapOptions: { id: string; statement: string }[] = [];
  let tacticOptions: { id: string; statement: string }[] = [];
  let ready: Awaited<ReturnType<typeof workshopReadiness>>["readiness"] | null = null;
  let hasSnapshot = false;
  const aiOn = await aiEnabled();

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      pairs = await listCoveragePairs(workspaceId);
      const active = (await listClaims(workspaceId, { limit: 500 })).filter(isActiveLedgerClaim);
      gapOptions = active
        .filter((c) => c.claim_type === "gap")
        .map((c) => ({ id: c.id, statement: c.statement }));
      tacticOptions = active
        .filter((c) => c.claim_type === "tactic")
        .map((c) => ({ id: c.id, statement: c.statement }));
      const workshop = await workshopReadiness(workspaceId);
      ready = workshop.readiness;
      hasSnapshot = Boolean(await latestWorkshopSnapshot(workspaceId));
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load coverage";
  }

  const active = workspaces.find((w) => w.id === workspaceId);
  const queue = buildCoverageQueue(pairs);

  return (
    <AccuracyAppShell active="coverage">
      <PageIntro kicker="Pairwise · one decision at a time" title="Coverage">
        {aiOn
          ? "Work one undecided gap↔tactic pair at a time. Optional LLM assist suggests an overall and rationale — you still confirm with a decide button. Linked inventory pairs are preferred."
          : "Work one undecided gap↔tactic pair at a time: pick an overall and write the rationale yourself (AI is off, so there are no suggestions). Use the pair picker for any gap↔tactic pair."}
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <p className="text-[12px] text-muted-foreground">
          Open from{" "}
          <Link href="/admin/accuracy" className="underline-offset-2 hover:underline">
            Workspaces
          </Link>{" "}
          with a <code>workspace_id</code>.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · {active?.name ?? workspaceId} · {queue.total_count} pair(s) ·{" "}
            {queue.undecided_count} undecided
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
          <CoverageManualPairForm
            workspaceId={workspaceId}
            gaps={gapOptions}
            tactics={tacticOptions}
          />
          {pairs.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No gap/tactic pairs yet. Seed gold or add claims on the Ledger.
            </p>
          ) : (
            <CoverageQueue
              workspaceId={workspaceId}
              pairs={pairs.map((pair) => ({
                id: pair.id,
                gap_id: pair.gap.id,
                gap_statement: pair.gap.statement,
                tactic_id: pair.tactic.id,
                tactic_statement: pair.tactic.statement,
                overall: pair.overall,
                rationale: pair.rationale,
                validated: pair.validated,
              }))}
            />
          )}
        </>
      )}
    </AccuracyAppShell>
  );
}
