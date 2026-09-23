import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import {
  SourcesWorkspace,
  type SourceRowModel,
} from "@/components/accuracy/sources-workspace";
import { SourceUploadForm } from "@/components/accuracy/source-upload-form";
import { registerAccuracyStack } from "@/accuracy";
import { readParseBlocks } from "@/accuracy/store/parse-store";
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
  let sources: SourceRowModel[] = [];
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const rows = await listSourceFiles(workspaceId);
      sources = await Promise.all(
        rows.map(async (row) => {
          const [block_count, blockRows] = await Promise.all([
            countParseBlocks(workspaceId, row.id),
            readParseBlocks(workspaceId, row.id),
          ]);
          const blocks = [...blockRows]
            .sort((a, b) => a.index - b.index)
            .map((b) => ({
              id: b.id,
              index: b.index,
              kind: b.kind,
              heading: b.heading,
              text: b.text,
              parser: b.parser,
            }));
          return {
            id: row.id,
            filename: row.filename,
            mime: row.mime,
            doc_role: row.doc_role,
            block_count,
            reference_pack_id: row.reference_pack_id,
            parser: blocks[0]?.parser ?? null,
            blocks,
          };
        }),
      );
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load sources";
  }

  const active = workspaces.find((w) => w.id === workspaceId);

  return (
    <AccuracyAppShell active="sources">
      <PageIntro kicker="Ingest · parse · extract" title="Sources">
        PDF and PPTX prefer LlamaParse when <code>LLAMA_CLOUD_API_KEY</code> is set; without it they
        fall back to local structured parse. DOCX/XLSX/text stay local. After parse, preview blocks
        for quote audit, then run need + inventory extract to populate the ledger (requires a
        connected LLM or env API key).
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
            <p className="mt-3 text-[12px] text-muted-foreground">
              No sources yet. Upload above or seed from gold on the Workspaces page.
            </p>
          ) : (
            <div className="mt-3">
              <SourcesWorkspace workspaceId={workspaceId} sources={sources} />
            </div>
          )}
        </>
      )}
    </AccuracyAppShell>
  );
}
