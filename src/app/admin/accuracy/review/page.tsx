import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { MissFlagInbox, type MissFlagCardModel } from "@/components/accuracy/miss-flag-inbox";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import type { CompletenessAuditOutput } from "@/accuracy/modules/completeness-audit/module";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { workspacePlanLabel } from "@/accuracy/domain/plan-label";
import { getWorkspace, listWorkspaces } from "@/accuracy/store/tenant";
import { UnknownWorkspaceNotice, workspaceLabel } from "@/components/accuracy/unknown-workspace";
import { AiDisabledError, aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const access = await requireOwnerPage();
  const { workspace_id: workspaceId = "" } = await searchParams;

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let active: Awaited<ReturnType<typeof getWorkspace>> = null;
  let flags: MissFlagCardModel[] = [];
  let scanned = 0;
  let openCount = 0;
  let skippedNoise = 0;
  let loadError: string | null = null;
  // The completeness audit is an AI step that runs on page load: never with AI off.
  let aiOn = true;

  try {
    aiOn = await aiEnabled();
    workspaces = await listWorkspaces();
    // Looked up directly, so a workspace past the picker's cap still shows its name.
    if (workspaceId) active = await getWorkspace(workspaceId);
    if (active && aiOn) {
      const [result, sources] = await Promise.all([
        runAccuracyModule<CompletenessAuditOutput>({
          call_kind: "completeness_audit",
          agent_role: "critic",
          input: { workspace_id: workspaceId },
          // Credited to the signed-in owner who opened the inbox.
          actor: access.actor,
          org_id: active.org_id,
          workspace_id: workspaceId,
        }),
        listSourceFiles(workspaceId),
      ]);
      const filenameById = new Map(sources.map((s) => [s.id, s.filename]));
      scanned = result.output.scanned_blocks;
      openCount = result.output.open_flags;
      skippedNoise = result.output.skipped_noise;
      flags = result.output.flags.map((flag) => ({
        ...flag,
        source_filename: filenameById.get(flag.source_file_id) ?? flag.source_file_id,
      }));
    }
  } catch (error) {
    if (error instanceof AiDisabledError) {
      // Switched off between the check and the run: show the AI-off note, not an error.
      aiOn = false;
    } else {
      loadError = error instanceof Error ? error.message : "Could not load review inbox";
    }
  }

  const unknownWorkspace = Boolean(workspaceId) && !active && !loadError;

  return (
    <AccuracyAppShell active="review" planLabel={workspacePlanLabel(active)}>
      <PageIntro kicker="Recall gate · completeness audit" title="Review">
        Miss flags from parse blocks that are not yet in the ledger. A model critic reads each uncited
        block and flags the ones that state a gap or tactic the ledger is missing, with its reason.
        Promote to a draft gap or tactic, or dismiss with a rationale — every decision feeds hillclimb.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card p-2 text-[12px] text-destructive rounded-lg">
          {loadError}
        </p>
      ) : null}

      {unknownWorkspace ? (
        <UnknownWorkspaceNotice workspaceId={workspaceId} />
      ) : workspaceId && !aiOn ? (
        <section
          className="grid gap-2 border border-border bg-card p-3 rounded-lg"
          aria-labelledby="review-ai-off"
          data-testid="review-ai-off"
        >
          <h2 id="review-ai-off" className="text-[13px] font-semibold text-foreground">
            AI is off — the completeness audit is an AI step
          </h2>
          <p className="text-[12px] text-muted-foreground">
            No audit runs and no miss flags are raised while AI is off (an admin can turn AI on
            in the control panel). Add any missing gaps or tactics by hand on the{" "}
            <Link
              href={`/admin/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
              className="text-foreground underline-offset-2 hover:underline"
            >
              Ledger
            </Link>
            .
          </p>
          <p className="text-[12px] text-muted-foreground">
            Workspace · {active ? workspaceLabel(active) : workspaceId}
          </p>
        </section>
      ) : !workspaceId ? (
        <section className="grid gap-2" aria-labelledby="review-empty">
          <h2 id="review-empty" className="text-[13px] font-semibold text-foreground">
            Choose a workspace
          </h2>
          <p className="text-[12px] text-muted-foreground">
            Open from{" "}
            <Link href="/admin/accuracy" className="underline-offset-2 hover:underline">
              Workspaces
            </Link>{" "}
            with a <code>workspace_id</code>.
          </p>
          {workspaces.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/admin/accuracy/review?workspace_id=${encodeURIComponent(workspace.id)}`}
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
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · {active ? workspaceLabel(active) : workspaceId} · {scanned} block(s) scanned · {openCount} open
            miss flag(s)
            {skippedNoise > 0 ? ` · ${skippedNoise} judged not a miss by the model critic` : ""}
          </p>
          {scanned === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No parse blocks yet. Upload or seed a source on{" "}
              <Link
                href={`/admin/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId)}`}
                className="underline-offset-2 hover:underline"
              >
                Sources
              </Link>
              .
            </p>
          ) : (
            <MissFlagInbox workspaceId={workspaceId} flags={flags} />
          )}
        </>
      )}
    </AccuracyAppShell>
  );
}
