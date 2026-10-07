import { AccuracyPausedError, assertAccuracyCanProgress } from "@/accuracy/kernel/omission-pause";
import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { CoverageQueue } from "@/components/accuracy/coverage-queue";
import { CoverageManualPairForm } from "@/components/accuracy/coverage-manual-pair-form";
import { claimFactualRevision } from "@/accuracy/domain/structured-fields";
import { WorkshopSaveCta } from "@/components/accuracy/workshop-save-cta";
import { registerAccuracyStack } from "@/accuracy";
import { listCoveragePage, listCoverageInventory, type CoveragePage } from "@/accuracy/store/coverage-store";
import { workspacePlanLabel } from "@/accuracy/domain/plan-label";
import { getWorkspace } from "@/accuracy/store/tenant";
import { UnknownWorkspaceNotice, workspaceLabel } from "@/components/accuracy/unknown-workspace";
import { latestWorkshopSnapshot, workshopReadiness } from "@/accuracy/store/workshop-store";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string; cursor?: string }>;
}) {
  await requireOwnerPage();
  const { workspace_id: workspaceId = "", cursor } = await searchParams;
  let active: Awaited<ReturnType<typeof getWorkspace>> = null;
  let page: Awaited<ReturnType<typeof listCoveragePage>> | null = null;
  let pairs: CoveragePage["pairs"] = [];
  let loadError: string | null = null;
  let gapOptions: { id: string; statement: string; revision: string }[] = [];
  let tacticOptions: { id: string; statement: string; revision: string }[] = [];
  let ready: Awaited<ReturnType<typeof workshopReadiness>>["readiness"] | null = null;
  let hasSnapshot = false;
  const aiOn = await aiEnabled();

  try {
    if (workspaceId) active = await getWorkspace(workspaceId);
    if (active) {
      await assertAccuracyCanProgress(workspaceId, "pair_generate");
      page = await listCoveragePage({ workspace_id: workspaceId, cursor, page_size: 100 });
      pairs = page.pairs;
      const inventory = await listCoverageInventory(workspaceId);
      gapOptions = inventory.gaps.map((c) => ({ id: c.id, statement: c.statement, revision: claimFactualRevision(c) }));
      tacticOptions = inventory.tactics.map((c) => ({ id: c.id, statement: c.statement, revision: claimFactualRevision(c) }));
      const workshop = await workshopReadiness(workspaceId);
      ready = workshop.readiness;
      hasSnapshot = Boolean(await latestWorkshopSnapshot(workspaceId));
    }
  } catch (error) {
    loadError = error instanceof AccuracyPausedError
      ? "Coverage is paused until important source omissions are resolved."
      : error instanceof Error ? error.message : "Could not load coverage";
  }

  const unknownWorkspace = Boolean(workspaceId) && !active && !loadError;

  return (
    <AccuracyAppShell active="coverage" planLabel={workspacePlanLabel(active)}>
      <PageIntro kicker="Pairwise · one decision at a time" title="Coverage">
        {aiOn
          ? "Work one undecided gap↔tactic pair at a time. Optional LLM assist suggests an overall and rationale — you still confirm with a decide button. Every eligible inventory pair is available across the pages."
          : "Work one undecided gap↔tactic pair at a time: pick an overall and write the rationale yourself (AI is off, so there are no suggestions). Use the pair picker for any gap↔tactic pair."}
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card p-2 text-[12px] text-destructive rounded-lg">
          {loadError} <Link href={`/admin/accuracy/coverage?workspace_id=${encodeURIComponent(workspaceId)}`} className="underline">Restart from first page</Link>
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
      ) : loadError ? null : unknownWorkspace ? (
        <UnknownWorkspaceNotice workspaceId={workspaceId} />
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · {active ? workspaceLabel(active) : workspaceId} · {page?.progress.eligible_total ?? 0} eligible pair(s) ·{" "}
            {page?.progress.assessed ?? 0} assessed · {page?.progress.validated ?? 0} validated · {page?.progress.pending ?? 0} pending ·{" "}
            {page?.progress.stale ?? 0} stale · {page?.progress.unknown ?? 0} unknown freshness · {page?.progress.failed ?? 0} failed ·{" "}
            {page?.progress.rejected ?? 0} rejected · {page?.progress.excluded_claims ?? 0} excluded claims
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
              cursor={cursor} snapshot={page?.snapshot}
              pairs={pairs.map((pair) => ({
                id: pair.id,
                gap_id: pair.gap.id,
                gap_statement: pair.gap.statement,
                tactic_id: pair.tactic.id,
                tactic_statement: pair.tactic.statement,
                overall: pair.overall,
                rationale: pair.rationale,
                validated: pair.validated, gap_revision: pair.gap_revision, tactic_revision: pair.tactic_revision,
                freshness: pair.freshness, validation_freshness: pair.validation_freshness,
                assessment_state: pair.assessment_state, failure_reason: pair.failure_reason,
                evidence: pair.evidence, protected: pair.protected,
              }))}
            />
          )}
          <nav className="mt-3 flex gap-3 text-[12px]" aria-label="Coverage pages">
            {cursor ? <Link href={`/admin/accuracy/coverage?workspace_id=${encodeURIComponent(workspaceId)}`} className="underline">First page / restart</Link> : null}
            {page?.next_cursor ? <Link href={`/admin/accuracy/coverage?workspace_id=${encodeURIComponent(workspaceId)}&cursor=${encodeURIComponent(page.next_cursor)}`} className="underline">Next 100 pairs</Link> : null}
          </nav>
          {page?.progress.exclusions.length ? <details className="mt-3 text-[12px]"><summary>Excluded claims and reasons</summary>
            <ul>{page.progress.exclusions.map((c) => <li key={c.claim_id}>{c.claim_id}: {c.reason}</li>)}</ul>
          </details> : null}
        </>
      )}
    </AccuracyAppShell>
  );
}
