"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  ParseBlockPreviewPanel,
  type ParseBlockPreviewModel,
} from "@/components/accuracy/parse-block-preview";
import { SourceExtractActions } from "@/components/accuracy/source-extract-actions";

export type SourceRowModel = {
  id: string;
  filename: string;
  mime: string;
  doc_role: string;
  block_count: number;
  reference_pack_id: string | null;
  parser: string | null;
  blocks: ParseBlockPreviewModel[];
};

/**
 * Sources list + side parse-block preview for the selected file.
 */
export function SourcesWorkspace({
  workspaceId,
  sources,
}: {
  workspaceId: string;
  sources: SourceRowModel[];
}) {
  const defaultId = useMemo(() => {
    const withBlocks = sources.find((s) => s.block_count > 0);
    return withBlocks?.id ?? sources[0]?.id ?? null;
  }, [sources]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const resolvedId =
    selectedId && sources.some((s) => s.id === selectedId) ? selectedId : defaultId;
  const selected = sources.find((s) => s.id === resolvedId) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] lg:items-start">
      <ul className="grid gap-2" data-testid="sources-list">
        {sources.map((source) => {
          const active = source.id === selected?.id;
          return (
            <li key={source.id}>
              <button
                type="button"
                data-testid="source-select"
                data-source-id={source.id}
                aria-pressed={active}
                onClick={() => setSelectedId(source.id)}
                className={`w-full border p-3 text-left transition-colors ${
                  active
                    ? "border-foreground bg-card/60"
                    : "border-border bg-card/40 hover:bg-muted/30"
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] font-medium text-foreground">{source.filename}</p>
                  <span className="text-[11px] text-muted-foreground">{source.doc_role}</span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>
                    {source.block_count} parse block(s) · {source.mime}
                    {source.reference_pack_id ? ` · pack ${source.reference_pack_id}` : ""}
                  </span>
                  {source.parser ? (
                    <Badge variant="outline" className="text-[10px]">
                      {source.parser}
                    </Badge>
                  ) : null}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">{source.id}</p>
              </button>
              {active ? (
                <div className="border border-t-0 border-border bg-card/20 px-3 pb-3">
                  <SourceExtractActions
                    workspaceId={workspaceId}
                    sourceFileId={source.id}
                    blockCount={source.block_count}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="lg:sticky lg:top-4">
        <ParseBlockPreviewPanel
          filename={selected?.filename}
          blocks={selected?.blocks ?? []}
          emptyHint={
            selected
              ? "No parse blocks for this source — re-upload or seed before quote audit."
              : "Select a source to preview parse blocks."
          }
        />
        <p className="mt-3 flex flex-wrap gap-3 text-[12px]">
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
          <Link
            href={`/accuracy/review?workspace_id=${encodeURIComponent(workspaceId)}`}
            className="underline-offset-2 hover:underline"
          >
            Review miss flags
          </Link>
        </p>
      </div>
    </div>
  );
}
