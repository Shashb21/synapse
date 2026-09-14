import { AppShell, InsightCard, PageIntro } from "@/components/insight-card";
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
      <p className="mb-6 text-sm text-muted-foreground">
        <Link href="/ingest" className="text-muted-foreground no-underline hover:text-foreground">
          Ingest
        </Link>
        <span className="mx-2">/</span>
        Source
      </p>
      <PageIntro title={doc.title}>
        <p>
          {doc.filename} · {FUNCTION_LABELS[doc.stakeholder_function]} ·{" "}
          {doc.parser} · {doc.blocks.length} blocks · {insights.length} insights
        </p>
      </PageIntro>
      {insights.length === 0 ? (
        <p className="text-base text-muted-foreground">
          No insights extracted from this source yet.
        </p>
      ) : (
        <div className="space-y-4">
          {insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              themes={state.themes}
              documents={[{ id: doc.id, title: doc.title, filename: doc.filename }]}
            />
          ))}
        </div>
      )}
    </AppShell>
  );
}
