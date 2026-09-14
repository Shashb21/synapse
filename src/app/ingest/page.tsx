"use client";

import { AppShell, PageIntro } from "@/components/insight-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FUNCTION_LABELS, type StakeholderFunction } from "@/lib/schema";
import { useEffect, useState } from "react";

type DocRow = {
  id: string;
  filename: string;
  title: string;
  stakeholder_function: StakeholderFunction;
  parser: string;
  blocks: number;
  ingested_at: string;
};

export default function IngestPage() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [providers, setProviders] = useState<{
    llama_cloud: boolean;
    anthropic: boolean;
    live_parser: string;
    live_extractor: string;
    anthropic_model: string | null;
    llama_tier: string | null;
  } | null>(null);
  const [fixtures, setFixtures] = useState<
    { filename: string; href: string; bytes: number }[]
  >([]);

  async function refresh() {
    const res = await fetch("/api/dashboard");
    if (!res.ok) throw new Error("Could not load sources");
    const data = await res.json();
    setDocs(data.documents);
  }

  useEffect(() => {
    refresh().catch((err: Error) => {
      setStatus("error");
      setMessage(err.message);
    });
    fetch("/api/fixtures")
      .then((r) => r.json())
      .then((d) => setFixtures(d.files ?? []))
      .catch(() => undefined);
    fetch("/api/status")
      .then((r) => r.json())
      .then(setProviders)
      .catch(() => undefined);
  }, []);

  async function onUpload(file: File) {
    setStatus("loading");
    setMessage(`Parsing ${file.name}…`);
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/ingest", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) {
      setStatus("error");
      setMessage(data.error ?? "Ingest failed");
      return;
    }
    setStatus("idle");
    const champion = data.dashboard?.champion_prompt_version as
      | string
      | undefined;
    setMessage(
      `${data.parserUsed === "llamaparse" ? "LlamaCloud" : "Local"} parse · ${data.extractor === "claude" ? "Claude extractor" : "local extractor"} · ${data.document.blocks} blocks · eval ${champion ?? "tape updated"}${data.llamaError ? ` · LlamaCloud fallback: ${data.llamaError}` : ""}`,
    );
    await refresh();
  }

  return (
    <AppShell active="ingest">
      <PageIntro title="Ingest a readout">
        LlamaCloud Parse reads PPTX graphics and graphs. Claude Sonnet then
        extracts atomic CIR insights. The eval hill-climb re-scores
        automatically after each ingest — Eval and Spec are view-only.
      </PageIntro>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold">Upload</h2>
          {providers ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Parser:{" "}
              <span className="font-medium text-foreground">
                {providers.llama_cloud
                  ? `LlamaCloud ${providers.llama_tier}`
                  : "local OOXML (set LLAMA_CLOUD_API_KEY)"}
              </span>
              {" · "}
              Extractor:{" "}
              <span className="font-medium text-foreground">
                {providers.anthropic
                  ? providers.anthropic_model
                  : "local (set ANTHROPIC_API_KEY)"}
              </span>
            </p>
          ) : null}
          <label className="mt-6 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-primary/40 bg-primary/5 px-6 py-12 text-center transition hover:bg-primary/10">
            <span className="text-base font-medium">
              Drop a PPTX, DOCX, XLSX, or PDF
            </span>
            <span className="mt-2 text-sm text-muted-foreground">
              Stakeholder function is inferred from the filename, then tagged on
              every insight
            </span>
            <Input
              className="mt-5 max-w-xs"
              type="file"
              accept=".pptx,.docx,.xlsx,.ppt,.doc,.xls,.pdf"
              disabled={status === "loading"}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUpload(file);
              }}
            />
          </label>
          {message ? (
            <p
              className={`mt-5 text-sm leading-6 ${status === "error" ? "text-destructive" : "text-foreground"}`}
            >
              {message}
            </p>
          ) : null}
          {status === "loading" ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Extracting atomic insights and re-running the eval tape…
            </p>
          ) : null}
        </section>

        <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          <h2 className="text-xl font-semibold">Velmara sample pack</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Five cross-functional readouts used as the gold eval corpus.
            Download and re-upload to watch the pipeline run on real Office
            files.
          </p>
          <ul className="mt-5 space-y-3">
            {fixtures.length === 0 ? (
              <li className="text-sm text-muted-foreground">
                Generating sample files…
              </li>
            ) : (
              fixtures.map((f) => (
                <li key={f.filename}>
                  <a
                    className="text-sm text-primary no-underline hover:underline"
                    href={f.href}
                    download
                  >
                    {f.filename}
                  </a>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {(f.bytes / 1024).toFixed(1)} KB
                  </span>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Source library</h2>
        {docs.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No documents ingested yet.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-border text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-5 py-3.5">Document</th>
                  <th className="px-5 py-3.5">Function</th>
                  <th className="px-5 py-3.5">Parser</th>
                  <th className="px-5 py-3.5">Blocks</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-b-0">
                    <td className="px-5 py-4">
                      <a
                        href={`/sources/${d.id}`}
                        className="font-medium text-primary no-underline hover:underline"
                      >
                        {d.title}
                      </a>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {d.filename}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      {FUNCTION_LABELS[d.stakeholder_function]}
                    </td>
                    <td className="px-5 py-4">{d.parser}</td>
                    <td className="px-5 py-4">{d.blocks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="mt-5"
          onSubmit={async (e) => {
            e.preventDefault();
            await fetch("/api/reset", { method: "POST" });
            setMessage("Reset to the Velmara seed corpus.");
            await refresh();
          }}
        >
          <Button variant="outline" type="submit">
            Reset to seed corpus
          </Button>
        </form>
      </section>
    </AppShell>
  );
}
