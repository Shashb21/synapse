import { AppShell, PageIntro } from "@/components/app-shell";
import { LockForm } from "@/components/lock-form";
import { IngestFileField } from "@/components/ingest-file-field";
import { SOURCE_TYPES, SOURCE_TYPE_LABELS, ACTOR_FUNCTIONS, FUNCTION_LABELS } from "@/lib/iegp/enums";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import { loadState } from "@/lib/iegp/store";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const state = await loadState();
  const ingestedTitles = new Set(state.sources.map((s) => s.title));

  return (
    <AppShell active="sources">
      <PageIntro kicker="Blank workspace — nothing is ingested yet" title="Sources">
        Start empty. Download a demo file and upload it, or ingest it directly. The engine
        extracts candidate gaps and tactics and drafts residuals. Nothing is accepted or
        prioritized until you say so.
      </PageIntro>

      <section className="mb-8" aria-labelledby="demo-pack">
        <h2 id="demo-pack" className="text-[15px] font-medium text-foreground">
          Demo source files
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Test pack for a new IEP. Files sit here uningested. Use them to walk extract →
          review → prioritize → assign.
        </p>
        <div className="grid gap-3">
          {DEMO_PACK.map((file) => {
            const ingested = ingestedTitles.has(file.title);
            return (
              <article key={file.id} className="border border-border bg-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[13px] text-foreground">{file.title}</p>
                  <span className="text-[11px] text-muted-foreground">
                    {ingested ? "Ingested" : "Not ingested"}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {file.filename} · {SOURCE_TYPE_LABELS[file.source_type]} ·{" "}
                  {FUNCTION_LABELS[file.stakeholder_function]}
                </p>
                <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                  {file.text.replace(/\s+/g, " ").slice(0, 220)}…
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={`/demo-sources/${file.filename}`}
                    download={file.filename}
                    className="inline-flex h-8 items-center rounded-lg border border-input px-2.5 text-[13px] text-foreground no-underline"
                  >
                    Download
                  </a>
                  <LockForm
                    label="Ingest this file"
                    action="ingest_demo"
                    extra={{ demo_id: file.id }}
                    confirmLabel="Ingest"
                  />
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className="mb-6 border border-border bg-card p-4">
        <h2 className="mb-3 text-[13px] text-foreground">Upload your own note</h2>
        <LockForm label="Ingest gaps and tactics" action="ingest" confirmLabel="Ingest">
          <IngestFileField />
          <input name="title" required placeholder="Title" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" />
          <select name="source_type" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {SOURCE_TYPES.map((s) => (
              <option key={s} value={s}>{SOURCE_TYPE_LABELS[s]}</option>
            ))}
          </select>
          <select name="stakeholder_function" className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
            {ACTOR_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>{FUNCTION_LABELS[fn]}</option>
            ))}
          </select>
          <textarea
            name="text"
            required
            placeholder="Paste interview notes or drop a downloaded demo file above. Gap cues such as 'need to understand' become candidate gaps. Mentions of trials, registries, chart reviews, or publications become extracted tactics."
            className="min-h-28 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </LockForm>
      </div>

      <h2 className="mb-3 text-[13px] text-foreground">Ingested sources</h2>
      {state.sources.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          None yet. This workspace is blank until you ingest a demo file or upload a note.
        </p>
      ) : (
        <div className="grid gap-3">
          {state.sources.map((s) => {
            const needCount = state.needs.filter((n) => n.source_id === s.id).length;
            const gapCount = state.need_gap_links.filter((l) =>
              state.needs.some((n) => n.id === l.need_id && n.source_id === s.id),
            ).length;
            const tacticCount = state.tactics.filter((tac) =>
              tac.intended_use.includes(s.id) || tac.data_source === s.title,
            ).length;
            return (
              <article key={s.id} className="border border-border bg-card p-4">
                <p className="text-[13px] text-foreground">{s.title}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {SOURCE_TYPE_LABELS[s.source_type]} · {FUNCTION_LABELS[s.stakeholder_function]} ·{" "}
                  {needCount} need{needCount === 1 ? "" : "s"} · {gapCount} linked gap
                  {gapCount === 1 ? "" : "s"}
                  {tacticCount ? ` · ${tacticCount} extracted tactic${tacticCount === 1 ? "" : "s"}` : ""}
                </p>
                <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                  {s.full_text.slice(0, 280)}
                  {s.full_text.length > 280 ? "…" : ""}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
