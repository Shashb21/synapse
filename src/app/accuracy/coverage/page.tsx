import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { CoveragePairCard } from "@/components/accuracy/coverage-pair-card";
import { registerAccuracyStack } from "@/accuracy";
import { listCoveragePairs } from "@/accuracy/store/coverage-store";
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
  const undecided = pairs.filter((p) => !p.validated).length;

  return (
    <AccuracyAppShell active="coverage">
      <PageIntro kicker="Pairwise · one decision at a time" title="Coverage">
        Decide whether each gap↔tactic pair covers, partially covers, or does not cover — with a
        rationale. Linked inventory pairs are preferred.
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
            Workspace · {active?.name ?? workspaceId} · {pairs.length} pair(s) · {undecided}{" "}
            undecided
          </p>
          {pairs.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No gap/tactic pairs yet. Seed gold or add claims on the Ledger.
            </p>
          ) : (
            <div className="grid gap-3">
              {pairs.slice(0, 20).map((pair) => (
                <CoveragePairCard
                  key={pair.id}
                  workspaceId={workspaceId}
                  pair={{
                    id: pair.id,
                    gap_id: pair.gap.id,
                    gap_statement: pair.gap.statement,
                    tactic_id: pair.tactic.id,
                    tactic_statement: pair.tactic.statement,
                    overall: pair.overall,
                    rationale: pair.rationale,
                    validated: pair.validated,
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </AccuracyAppShell>
  );
}
