import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { CoverageQueue } from "@/components/accuracy/coverage-queue";
import { registerAccuracyStack } from "@/accuracy";
import { listCoveragePairs } from "@/accuracy/store/coverage-store";
import { buildCoverageQueue } from "@/accuracy/store/coverage-queue";
import { listWorkspaces } from "@/accuracy/store/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let pairs: Awaited<ReturnType<typeof listCoveragePairs>> = [];
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) pairs = await listCoveragePairs(workspaceId);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load coverage";
  }

  const active = workspaces.find((w) => w.id === workspaceId);
  const queue = buildCoverageQueue(pairs);

  return (
    <AccuracyAppShell active="coverage">
      <PageIntro kicker="Pairwise · one decision at a time" title="Coverage">
        Work one undecided gap↔tactic pair at a time. Optional LLM assist suggests an overall and
        rationale — you still confirm with a decide button. Linked inventory pairs are preferred.
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
          </Link>{" "}
          with a <code>workspace_id</code>.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · {active?.name ?? workspaceId} · {queue.total_count} pair(s) ·{" "}
            {queue.undecided_count} undecided
          </p>
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
                tactic_start: pair.tactic_start,
                tactic_end: pair.tactic_end,
              }))}
            />
          )}
        </>
      )}
    </AccuracyAppShell>
  );
}
