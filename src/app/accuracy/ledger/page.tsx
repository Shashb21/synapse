import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { LedgerClaimCard, type LedgerClaimCardModel } from "@/components/accuracy/ledger-claim-card";
import { registerAccuracyStack } from "@/accuracy";
import { claimMetadata, listClaims } from "@/accuracy/store/claim-store";
import { listWorkspaces } from "@/accuracy/store/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

function toCard(claim: Awaited<ReturnType<typeof listClaims>>[number]): LedgerClaimCardModel {
  const meta = claimMetadata(claim);
  return {
    id: claim.id,
    claim_type: claim.claim_type,
    statement: claim.statement,
    status: claim.status,
    validated: claim.validated,
    source_badge: String(meta.source_badge ?? claim.source_file_id ?? "unspecified source"),
    validation_rationale: meta.validation?.rationale ?? null,
    start: typeof meta.start === "string" ? meta.start : null,
    end: typeof meta.end === "string" ? meta.end : null,
  };
}

export default async function AccuracyLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let gaps: LedgerClaimCardModel[] = [];
  let tactics: LedgerClaimCardModel[] = [];
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const claims = await listClaims(workspaceId);
      gaps = claims.filter((c) => c.claim_type === "gap").map(toCard);
      tactics = claims.filter((c) => c.claim_type === "tactic").map(toCard);
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load ledger";
  }

  const activeWorkspace = workspaces.find((row) => row.id === workspaceId);

  return (
    <AccuracyAppShell active="ledger">
      <PageIntro kicker="Human gate · gaps & tactics" title="Ledger">
        Draft and validated claims for one workspace. Validate or reject with a rationale — every
        decision feeds hillclimb.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <section className="grid gap-2" aria-labelledby="ledger-empty">
          <h2 id="ledger-empty" className="text-[15px] font-medium text-foreground">
            Choose a workspace
          </h2>
          <p className="text-[12px] text-muted-foreground">
            No workspace selected. Open a workspace from{" "}
            <Link href="/accuracy" className="text-foreground underline-offset-2 hover:underline">
              Workspaces
            </Link>{" "}
            or append <code className="text-[11px]">?workspace_id=</code> to this URL.
          </p>
          {workspaces.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className="inline-flex rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground no-underline hover:text-foreground"
                  >
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <>
          <section className="mb-6 grid gap-2" aria-labelledby="workspace-picker">
            <h2 id="workspace-picker" className="text-[15px] font-medium text-foreground">
              Workspace
              {activeWorkspace ? (
                <span className="ml-2 text-[12px] font-normal text-muted-foreground">
                  · {activeWorkspace.name}
                </span>
              ) : null}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspace.id)}`}
                    className={`inline-flex rounded-md border px-2 py-1 text-[12px] no-underline ${
                      workspace.id === workspaceId
                        ? "border-foreground bg-card text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="mb-8 grid gap-2" aria-labelledby="gaps-section">
            <h2 id="gaps-section" className="text-[15px] font-medium text-foreground">
              Gaps
            </h2>
            {gaps.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No gap claims in this workspace yet.</p>
            ) : (
              <ul className="grid gap-2">
                {gaps.map((claim) => (
                  <LedgerClaimCard key={claim.id} claim={claim} workspaceId={workspaceId} />
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-2" aria-labelledby="tactics-section">
            <h2 id="tactics-section" className="text-[15px] font-medium text-foreground">
              Tactics
            </h2>
            {tactics.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No tactic claims in this workspace yet.
              </p>
            ) : (
              <ul className="grid gap-2">
                {tactics.map((claim) => (
                  <LedgerClaimCard key={claim.id} claim={claim} workspaceId={workspaceId} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </AccuracyAppShell>
  );
}
