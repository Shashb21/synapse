import { AppShell, InsightRow } from "@/components/insight-card";
import { FUNCTION_LABELS } from "@/lib/schema";
import { getState } from "@/lib/store";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const state = await getState();
  const doc = state.documents.find((d) => d.id === id);
  if (!doc) notFound();
  const insights = state.insights.filter((i) => i.source_document_id === id);

  return (
    <AppShell active="ingest">
      <p className="text-[10px] tracking-widest text-muted-foreground">
        <Link href="/ingest" className="text-muted-foreground">
          INGEST
        </Link>
        {" / SOURCE"}
      </p>
      <h1 className="mt-2 text-sm tracking-[0.2em] text-primary">
        {doc.title.toUpperCase()}
      </h1>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {doc.filename} · {FUNCTION_LABELS[doc.stakeholder_function]} · {doc.parser} ·{" "}
        {doc.blocks.length} blocks · {insights.length} insights
      </p>
      <div className="mt-4 overflow-x-auto border border-border">
        <table className="w-full min-w-[860px] text-left">
          <thead className="border-b border-border bg-muted/40 text-[10px] tracking-widest text-muted-foreground">
            <tr>
              <th className="px-2 py-2">CLS</th>
              <th className="px-2 py-2">INSIGHT</th>
              <th className="px-2 py-2">LOCATION</th>
              <th className="px-2 py-2">THEMES</th>
            </tr>
          </thead>
          <tbody>
            {insights.map((insight) => (
              <InsightRow
                key={insight.id}
                insight={insight}
                themes={state.themes}
                documents={[{ id: doc.id, title: doc.title, filename: doc.filename }]}
              />
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
