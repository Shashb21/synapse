import { LockForm } from "@/components/lock-form";
import { AddSourceForm } from "@/components/add-source-form";
import {
  SOURCE_TYPE_LABELS,
  FUNCTION_LABELS,
} from "@/lib/iegp/enums";
import { DEMO_PACK } from "@/lib/iegp/demo-pack";
import type { SourceDocument } from "@/lib/iegp/types";

/**
 * Upload: add a source of your own, plus the Velmara demo source files in a demo
 * workspace only. A team's own workspace never offers demo content unasked.
 */
export function IngestPanel({
  sources,
  compact,
  demoFiles = false,
}: {
  sources: SourceDocument[];
  compact?: boolean;
  /** The workspace holds the Velmara demo: offer its demo source files. */
  demoFiles?: boolean;
}) {
  const ingestedTitles = new Set(sources.map((s) => s.title));

  return (
    <div>
      {demoFiles ? (
      <section aria-labelledby="demo-pack">
        <h2 id="demo-pack" className="text-[13px] font-semibold text-foreground">
          Demo source files
        </h2>
        <p className="mb-4 mt-1 text-[12px] text-muted-foreground">
          Nothing is ingested until you do it. Ingesting a file reads it, pulls out its evidence gaps
          and tactics and maps them, using the connected AI model. If no model is connected it stops
          and says so.
        </p>
        <div className="grid gap-3">
          {DEMO_PACK.map((file) => {
            const ingested = ingestedTitles.has(file.title);
            return (
              <article key={file.id} className="border border-border bg-card p-4 rounded-lg">
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
                {compact ? null : (
                  <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                    {file.text.replace(/\s+/g, " ").slice(0, 220)}…
                  </p>
                )}
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
      ) : null}

      <div className={demoFiles ? "mt-6" : undefined}>
        <AddSourceForm demoFiles={demoFiles} />
      </div>

      {compact ? null : (
        <>
          <h2 className="mb-3 mt-8 text-[13px] text-foreground">Ingested sources</h2>
          {sources.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">None yet.</p>
          ) : (
            <div className="grid gap-3">
              {sources.map((s) => (
                <article key={s.id} className="border border-border bg-card p-4 rounded-lg">
                  <p className="text-[13px] text-foreground">{s.title}</p>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {SOURCE_TYPE_LABELS[s.source_type]} · {FUNCTION_LABELS[s.stakeholder_function]}
                  </p>
                  <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
                    {s.full_text.slice(0, 280)}
                    {s.full_text.length > 280 ? "…" : ""}
                  </p>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
