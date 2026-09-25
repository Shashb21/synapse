import { requireOwnerPage } from "@/modules/auth/owner";
import Link from "next/link";
import { AccuracyAppShell, PageIntro } from "@/components/accuracy-app-shell";
import { ParseBlockPreview, ParseSourceControls } from "@/components/accuracy/parse-block-preview";
import { ManualSourceForm } from "@/components/platform/manual-source-form";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { sessionContext } from "@/modules/auth/session";
import { STAKEHOLDER_FUNCTIONS } from "@/lib/schema";
import { SourceExtractActions, ExtractOauthGateBanner } from "@/components/accuracy/source-extract-actions";
import { SourceUploadForm } from "@/components/accuracy/source-upload-form";
import { registerAccuracyStack, inspectLiveExtractGate } from "@/accuracy";
import { toParseBlockPreviews } from "@/accuracy/store/parse-preview";
import {
  PARSE_BLOCK_KINDS,
  listDroppedUnits,
  readParseBlocksWithMeta,
  readSourceStakeholder,
} from "@/accuracy/store/parse-store";
import { listSourceFiles } from "@/accuracy/store/source-store";
import { listWorkspaces } from "@/accuracy/store/tenant";
import { aiEnabled } from "@/modules/kernel/ai-switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

registerAccuracyStack();

export default async function AccuracySourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string }>;
}) {
  await requireOwnerPage();
  const { workspace_id: workspaceId = "" } = await searchParams;
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  let sources: Array<
    Awaited<ReturnType<typeof listSourceFiles>>[number] & {
      block_count: number;
      parse_blocks: (ReturnType<typeof toParseBlockPreviews>[number] & {
        provenance: Awaited<ReturnType<typeof readParseBlocksWithMeta>>[number]["provenance"];
      })[];
      stakeholder: Awaited<ReturnType<typeof readSourceStakeholder>>;
      dropped: Awaited<ReturnType<typeof listDroppedUnits>>;
    }
  > = [];
  let loadError: string | null = null;

  try {
    workspaces = await listWorkspaces();
    if (workspaceId) {
      const rows = await listSourceFiles(workspaceId);
      sources = await Promise.all(
        rows.map(async (row) => {
          const stored = await readParseBlocksWithMeta(workspaceId, row.id);
          const parse_blocks = toParseBlockPreviews(stored).map((preview) => ({
            ...preview,
            provenance: stored.find((block) => block.id === preview.id)!.provenance,
          }));
          return {
            ...row,
            block_count: parse_blocks.length,
            parse_blocks,
            stakeholder: await readSourceStakeholder(workspaceId, row.id),
            dropped: await listDroppedUnits(workspaceId, row.id),
          };
        }),
      );
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load sources";
  }

  const active = workspaces.find((w) => w.id === workspaceId);
  // AI off (owner's decision): no upload, parse, hand-typed source or extract —
  // existing sources are shown read-only and gaps/tactics are added on the Ledger.
  const aiOn = await aiEnabled();
  const extractGate = aiOn ? await inspectLiveExtractGate() : null;
  const session = await sessionContext();
  const identity: ActionIdentity = {
    signed_in: session.signed_in,
    actor_name: session.actor.name,
    actor_function: session.actor.function,
  };

  return (
    <AccuracyAppShell active="sources">
      <PageIntro kicker="Ingest · parse · extract" title="Sources">
        {aiOn ? (
          <>
            Every file is parsed by the chosen LLM: its text is extracted, then the model decides
            the blocks, their kinds and headings. After parse, preview verbatim parse blocks
            (quotes must be substrings of this text), then run need + inventory extract to populate
            the ledger. Live extract uses a connected OAuth LLM from the{" "}
            <Link href="/admin/control" className="underline-offset-2 hover:underline">
              control panel
            </Link>{" "}
            (Grok default, Claude one-click).
          </>
        ) : (
          <>
            AI is off, so there is no upload, parsing or extraction. Sources already in this
            workspace are listed read-only. Add gaps and tactics by hand on the Ledger.
          </>
        )}
      </PageIntro>

      {loadError ? (
        <p className="mb-4 border border-destructive/40 bg-card/40 p-2 text-[12px] text-destructive">
          {loadError}
        </p>
      ) : null}

      {!workspaceId ? (
        <p className="text-[12px] text-muted-foreground">
          Select a workspace from{" "}
          <Link href="/admin/accuracy" className="underline-offset-2 hover:underline">
            Workspaces
          </Link>{" "}
          (or open with <code>?workspace_id=</code>).
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Workspace · <span className="text-foreground">{active?.name ?? workspaceId}</span>
          </p>
          {!aiOn ? (
            <div
              className="mb-3 grid gap-1 border border-border bg-card/40 p-3"
              role="status"
              data-testid="sources-ai-off"
            >
              <p className="text-[13px] text-foreground">
                AI is off — upload, parse and extract are AI steps.
              </p>
              <p className="text-[12px] text-muted-foreground">
                Enter gaps and tactics yourself:{" "}
                <Link
                  href={`/admin/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  Add gaps and tactics on the Ledger →
                </Link>
              </p>
            </div>
          ) : null}
          {extractGate ? <ExtractOauthGateBanner gate={extractGate} /> : null}
          {aiOn ? <SourceUploadForm workspaceId={workspaceId} /> : null}
          {aiOn ? (
            <details className="mb-3 border border-border bg-card/40 p-3">
              <summary className="cursor-pointer text-[12px] text-foreground">
                Type or paste a source by hand (no AI)
              </summary>
              <p className="mb-2 mt-1 text-[11px] text-muted-foreground">
                One block per paragraph you confirm. Stored as human-entered; no model runs and a re-parse never
                replaces these blocks.
              </p>
              <ManualSourceForm
                endpoint="/api/accuracy/sources/blocks"
                payload={{ workspace_id: workspaceId }}
                fields={[
                  { name: "filename", label: "Name", required: true, placeholder: "kol-call-notes.txt" },
                  {
                    name: "doc_role",
                    label: "Document role",
                    type: "select",
                    options: ["interview", "medical", "heor", "publications", "iis", "other"].map((v) => ({
                      value: v,
                      label: v,
                    })),
                  },
                  {
                    name: "stakeholder_function",
                    label: "Stakeholder function",
                    type: "select",
                    options: STAKEHOLDER_FUNCTIONS.map((v) => ({ value: v, label: v })),
                  },
                ]}
                kindOptions={PARSE_BLOCK_KINDS}
                identity={identity}
              />
            </details>
          ) : null}
          {sources.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              {aiOn
                ? "No sources yet. Upload above or seed from gold on the Workspaces page."
                : "No sources in this workspace."}
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
                  {aiOn ? (
                    <ParseSourceControls
                      edit={{ workspaceId, sourceFileId: source.id, identity, kinds: PARSE_BLOCK_KINDS }}
                      stakeholder={source.stakeholder}
                      stakeholderOptions={STAKEHOLDER_FUNCTIONS}
                      dropped={source.dropped}
                    />
                  ) : null}
                  <ParseBlockPreview
                    blocks={source.parse_blocks}
                    edit={
                      aiOn
                        ? { workspaceId, sourceFileId: source.id, identity, kinds: PARSE_BLOCK_KINDS }
                        : undefined
                    }
                  />
                  {extractGate ? (
                    <SourceExtractActions
                      workspaceId={workspaceId}
                      sourceFileId={source.id}
                      blockCount={source.block_count}
                      gate={extractGate}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 flex flex-wrap gap-3 text-[12px]">
            <Link
              href={`/admin/accuracy/ledger?workspace_id=${encodeURIComponent(workspaceId)}`}
              className="underline-offset-2 hover:underline"
            >
              Open ledger
            </Link>
            <Link
              href={`/admin/accuracy/coverage?workspace_id=${encodeURIComponent(workspaceId)}`}
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
