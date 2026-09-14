"use client";

import { AppShell } from "@/components/insight-card";
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
    setMessage(
      `Extracted via ${data.parserUsed} parser · ${data.document.blocks} blocks · function ${FUNCTION_LABELS[data.document.stakeholder_function as StakeholderFunction]}`,
    );
    await refresh();
  }

  return (
    <AppShell active="ingest">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <section className="rounded-xl border border-border/80 bg-card p-5">
          <h2 className="font-heading text-2xl text-primary">
            Ingest a readout
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Drop the PowerPoint, Word, or Excel the brand team just walked.
            LlamaParse runs when <code>LLAMA_CLOUD_API_KEY</code> is set;
            otherwise native PPTX/DOCX/XLSX parsers flatten the file into CIR
            source blocks.
          </p>
          <label className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-primary/30 bg-muted/40 px-6 py-10 text-center">
            <span className="text-sm font-medium">
              Upload PPTX, DOCX, or XLSX
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              Stakeholder function is inferred from the filename, then tagged on
              every insight
            </span>
            <Input
              className="mt-4 max-w-xs"
              type="file"
              accept=".pptx,.docx,.xlsx,.ppt,.doc,.xls"
              disabled={status === "loading"}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUpload(file);
              }}
            />
          </label>
          {message ? (
            <p
              className={`mt-4 text-sm ${status === "error" ? "text-destructive" : "text-foreground"}`}
            >
              {message}
            </p>
          ) : null}
          {status === "loading" ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Extracting atomic insights…
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-border/80 bg-card p-5">
          <h2 className="font-heading text-2xl text-primary">
            Velmara sample pack
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Five cross-functional readouts used as the gold eval corpus. Download
            and re-upload to watch the pipeline run on real Office files.
          </p>
          <ul className="mt-4 space-y-2">
            {fixtures.length === 0 ? (
              <li className="text-sm text-muted-foreground">
                Generating sample files…
              </li>
            ) : (
              fixtures.map((f) => (
                <li key={f.filename}>
                  <a
                    className="text-sm text-primary underline-offset-2 hover:underline"
                    href={f.href}
                    download
                  >
                    {f.filename}
                  </a>
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {(f.bytes / 1024).toFixed(1)} KB
                  </span>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>

      <section className="mt-8">
        <h2 className="font-heading text-2xl text-primary">Source library</h2>
        {docs.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No documents ingested yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-border/80 bg-card">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b bg-muted/50 text-[11px] tracking-wider text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2">Document</th>
                  <th className="px-3 py-2">Function</th>
                  <th className="px-3 py-2">Parser</th>
                  <th className="px-3 py-2">Blocks</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="border-b border-border/60">
                    <td className="px-3 py-2">
                      <div className="font-medium">{d.title}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {d.filename}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {FUNCTION_LABELS[d.stakeholder_function]}
                    </td>
                    <td className="px-3 py-2">{d.parser}</td>
                    <td className="px-3 py-2">{d.blocks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="mt-4"
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
