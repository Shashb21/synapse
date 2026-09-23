import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { SourceUploadForm } from "@/components/accuracy/source-upload-form";
import { registerAccuracyStack } from "@/accuracy";
import { countParseBlocks, listSourceFiles } from "@/accuracy/store/source-store";
import { listWorkspaces } from "@/accuracy/store/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracySourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  const { workspace_id: workspaceId = "" } = await searchParams;
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let sources: Array<Awaited<ReturnType<typeof listSourceFiles>>[number] & { block_count: number }> =
    [];
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const rows = await listSourceFiles(workspaceId);
      sources = await Promise.all(
        rows.map(async (row) => ({
          ...row,
          block_count: await countParseBlocks(workspaceId, row.id),
        })),
      );
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load sources";
  }

  const active = workspaces.find((w) => w.id === workspaceId);

  return (
    <AccuracyAppShell active="sources">
      <PageIntro kicker="Ingest · parse health" title="Sources">
        Uploaded documents for one IEGP workspace. PPTX/DOCX parse locally without LlamaParse; PDF
        still needs a LlamaCloud key.
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <p className="text-[12px] text-muted-foreground">
          Select a workspace from{" "}
          <Link href="/accuracy" className="underline-offset-2 hover:underline">
            Workspaces
          </Link>{" "}
          (or open with <code>?workspace_id=</code>).
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · <span className="text-foreground">{active?.name ?? workspaceId}</span>
          </p>
          <SourceUploadForm workspaceId={workspaceId} />
          {sources.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No sources yet. Upload above or seed from gold on the Workspaces page.
            </p>
          ) : (
            <ul className="grid gap-2">
              {sources.map((source) => (
                <li key={source.id} className="border border-border bg-card/40 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px] font-medium text-foreground">{source.filename}</p>
                    <span className="text-[11px] text-muted-foreground">{source.doc_role}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {source.block_count} parse block(s) · {source.mime}
                    {source.reference_pack_id ? ` · pack ${source.reference_pack_id}` : ""}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{source.id}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 flex flex-wrap gap-3 text-[12px]">
            <Link
              href={`/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
              className="underline-offset-2 hover:underline"
            >
              Open ledger
            </Link>
            <Link
              href={`/accuracy/coverage?workspace_id=${encodeURIComponent(workspaceId)}`}
              className="underline-offset-2 hover:underline"
            >
              Coverage queue
            </Link>
          </p>
        </>
      )}
    </AccuracyAppShell>
  );
}
