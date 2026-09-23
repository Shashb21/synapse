import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { MissFlagInbox, type MissFlagCardModel } from "@/components/accuracy/miss-flag-inbox";
import { registerAccuracyStack, runAccuracyModule } from "@/accuracy";
import type { CompletenessAuditOutput } from "@/accuracy/modules/completeness-audit/module";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { listWorkspaces } from "@/accuracy/store/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracyReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;

  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let flags: MissFlagCardModel[] = [];
  let scanned = 0;
  let openCount = 0;
  let skippedNoise = 0;
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const org = workspaces.find((w) => w.id === workspaceId);
      if (org) {
        const [result, sources] = await Promise.all([
          runAccuracyModule<CompletenessAuditOutput>({
            call_kind: "completeness_audit",
            agent_role: "none",
            input: { workspace_id: workspaceId },
            actor: { name: "Accuracy reviewer", function: "medical_affairs" },
            org_id: org.org_id,
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
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load review inbox";
  }

  const active = workspaces.find((w) => w.id === workspaceId);

  return (
    <AccuracyAppShell active="review">
      <PageIntro kicker="Recall gate · completeness audit" title="Review">
        Miss flags from parse blocks that are not yet in the ledger. Heading-only, chapter, and SI
        chrome is skipped so Review stays usable on full PPTX gold. Promote to a draft gap or tactic,
        or dismiss with a rationale — every decision feeds hillclimb.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <section className="grid gap-2" aria-labelledby="review-empty">
          <h2 id="review-empty" className="text-[15px] font-medium text-foreground">
            Choose a workspace
          </h2>
          <p className="text-[12px] text-muted-foreground">
            Open from{" "}
            <Link href="/accuracy" className="underline-offset-2 hover:underline">
              Workspaces
            </Link>{" "}
            with a <code>workspace_id</code>.
          </p>
          {workspaces.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    href={`/accuracy/review?workspace_id=${encodeURIComponent(workspace.id)}`}
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
            Workspace · {active?.name ?? workspaceId} · {scanned} block(s) scanned · {openCount} open
            miss flag(s)
            {skippedNoise > 0 ? ` · ${skippedNoise} heading/chapter/SI skipped` : ""}
          </p>
          {scanned === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No parse blocks yet. Upload or seed a source on{" "}
              <Link
                href={`/accuracy/sources?workspace_id=${encodeURIComponent(workspaceId)}`}
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
