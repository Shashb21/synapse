"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AiSectionId } from "@/modules/kernel/ai-sections";
import { cn } from "@/lib/utils";

type HarnessCase = {
  id: AiSectionId;
  label: string;
  stages: readonly string[];
  detail: string;
  built: boolean;
  /** Whether customers have this section's AI on right now. */
  customersOn: boolean;
};

type Step = { stage: string; run_id: string; module: string; mode: string; summary: string; output: unknown };
type Result = { route: string; duration_ms: number; steps: Step[]; input_summary: string; started_at: string };

const FIELD = "h-8 w-full rounded-lg border border-input bg-card px-2.5 text-[12px] text-foreground";
const AREA = "w-full rounded-lg border border-input bg-card px-2.5 py-2 text-[12px] text-foreground";
const LABEL = "grid gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

/** What each use case runs on. */
const SAMPLE_NOTE: Record<AiSectionId, string> = {
  ingestion: "Uploads and parses the chosen Velmara source file.",
  gap_extraction: "Parses the chosen Velmara source, then extracts its evidence gaps.",
  tactic_extraction: "Parses the chosen Velmara source, then extracts the tactics it mentions.",
  mapping: "Maps every Velmara gap against the Velmara tactic library.",
  gap_status: "",
  partial_split: "Suggests a split for the first partially addressed Velmara gap.",
  prioritization: "Places every Velmara Open gap on the saved matrix axes.",
  ideation: "Designs tactics for the Velmara gaps validated as High priority.",
};

const TAKES_SOURCE: AiSectionId[] = ["ingestion", "gap_extraction", "tactic_extraction"];
const TAKES_GAP: AiSectionId[] = ["mapping", "prioritization", "ideation"];

function HarnessCard({
  entry,
  demoFiles,
  domains,
}: {
  entry: HarnessCase;
  demoFiles: { id: string; title: string }[];
  domains: { value: string; label: string }[];
}) {
  const [mode, setMode] = useState<"sample" | "custom">("sample");
  const [demoId, setDemoId] = useState(demoFiles[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [gapName, setGapName] = useState("");
  const [gapStatement, setGapStatement] = useState("");
  const [gapDomain, setGapDomain] = useState("");
  const [partialGaps, setPartialGaps] = useState<{ id: string; name: string }[] | null>(null);
  const [gapId, setGapId] = useState("");
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (entry.id !== "partial_split" || mode !== "custom" || partialGaps) return;
    void fetch("/api/admin/harness")
      .then((res) => res.json())
      .then((json: { partial_gaps?: { id: string; name: string }[] }) => {
        setPartialGaps(json.partial_gaps ?? []);
        setGapId(json.partial_gaps?.[0]?.id ?? "");
      })
      .catch(() => setPartialGaps([]));
  }, [entry.id, mode, partialGaps]);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  async function run() {
    setPending(true);
    setError(null);
    setResult(null);
    const started = Date.now();
    setElapsed(0);
    timer.current = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    const res = await fetch("/api/admin/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case: entry.id,
        mode,
        demo_id: demoId,
        title,
        text,
        gap_name: gapName,
        gap_statement: gapStatement,
        gap_domain: gapDomain || undefined,
        gap_id: gapId || undefined,
      }),
    }).catch(() => null);
    if (timer.current) clearInterval(timer.current);
    setPending(false);
    const json = (await res?.json().catch(() => ({}))) as { result?: Result; error?: string; code?: string } | undefined;
    if (!res?.ok || !json?.result) {
      setError({ message: json?.error ?? "The run failed.", code: json?.code });
      return;
    }
    setResult(json.result);
  }

  const main = result?.steps.at(-1);
  const setup = result ? result.steps.slice(0, -1) : [];

  return (
    <article
      className="grid gap-3 rounded-lg border border-border bg-card p-4"
      data-testid={`harness-${entry.id}`}
      aria-labelledby={`harness-${entry.id}-title`}
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`harness-${entry.id}-title`} className="text-[13px] font-semibold text-foreground">
            {entry.label} <span className="font-mono text-[10px] font-normal text-muted-foreground">{entry.stages.join(" · ")}</span>
          </h2>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{entry.detail}</p>
        </div>
        {entry.built ? (
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-[10px] font-semibold",
              entry.customersOn ? "bg-[var(--known)]/15 text-[var(--known-foreground)]" : "bg-muted text-muted-foreground",
            )}
          >
            Customers: AI {entry.customersOn ? "on" : "off"}
          </span>
        ) : (
          <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
            No AI module developed yet
          </span>
        )}
      </header>

      {!entry.built ? (
        <p className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[12px] text-foreground" role="note">
          There is no AI module for this use case, so there is nothing to run. Today the gap status is computed by rules
          from the mappings (completed, ongoing and planned tactics count; proposed ones do not) and a person confirms it
          on Evidence Inventory.
        </p>
      ) : (
        <>
          <div role="tablist" aria-label={`${entry.label} input`} className="flex gap-1">
            {(["sample", "custom"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-[11px] font-medium",
                  mode === value ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground",
                )}
              >
                {value === "sample" ? "Velmara sample" : "Your own input"}
              </button>
            ))}
          </div>

          {mode === "sample" ? (
            <div className="grid gap-2">
              <p className="text-[11px] text-muted-foreground">{SAMPLE_NOTE[entry.id]}</p>
              {TAKES_SOURCE.includes(entry.id) ? (
                <label className={LABEL}>
                  Sample source
                  <select value={demoId} onChange={(event) => setDemoId(event.target.value)} className={FIELD}>
                    {demoFiles.map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : TAKES_SOURCE.includes(entry.id) ? (
            <div className="grid gap-2">
              <label className={LABEL}>
                Title
                <input value={title} onChange={(event) => setTitle(event.target.value)} className={FIELD} placeholder="e.g. Payer advisory notes" />
              </label>
              <label className={LABEL}>
                Source text
                <textarea
                  rows={5}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  className={AREA}
                  placeholder="Paste interview notes, a literature review or a plan excerpt."
                />
              </label>
            </div>
          ) : TAKES_GAP.includes(entry.id) ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={LABEL}>
                Gap title
                <input value={gapName} onChange={(event) => setGapName(event.target.value)} className={FIELD} />
              </label>
              <label className={LABEL}>
                Domain
                <select value={gapDomain} onChange={(event) => setGapDomain(event.target.value)} className={FIELD}>
                  <option value="">Any</option>
                  {domains.map((domain) => (
                    <option key={domain.value} value={domain.value}>
                      {domain.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${LABEL} sm:col-span-2`}>
                What evidence is missing
                <textarea rows={3} value={gapStatement} onChange={(event) => setGapStatement(event.target.value)} className={AREA} />
              </label>
              <p className="text-[11px] text-muted-foreground sm:col-span-2">
                Runs against the Velmara plan in the sandbox, with your gap added to it.
              </p>
            </div>
          ) : (
            <label className={LABEL}>
              Partially addressed gap
              <select value={gapId} onChange={(event) => setGapId(event.target.value)} className={FIELD} disabled={!partialGaps}>
                {!partialGaps ? <option>Loading…</option> : null}
                {partialGaps?.map((gap) => (
                  <option key={gap.id} value={gap.id}>
                    {gap.id} · {gap.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void run()} disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {pending ? `Running… ${elapsed}s` : "Run on the live model"}
            </Button>
            <span className="text-[11px] text-muted-foreground">Runs in a private sandbox; no customer data is touched.</span>
          </div>

          {error ? (
            <p role="alert" className="text-[12px] text-destructive">
              {error.message}{" "}
              {error.code === "no_model" ? (
                <Link href="/admin/control" className="text-foreground">
                  Open AI &amp; routing
                </Link>
              ) : null}
            </p>
          ) : null}

          {result && main ? (
            <section className="grid gap-2 border-t border-border pt-3" aria-label={`${entry.label} result`} data-testid="harness-result">
              <dl className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Model</dt>
                  <dd className="text-foreground">{result.route}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Time</dt>
                  <dd className="text-foreground">{(result.duration_ms / 1000).toFixed(1)}s</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Input</dt>
                  <dd className="text-foreground">{result.input_summary}</dd>
                </div>
              </dl>
              <div className="rounded-md border border-border bg-background p-3">
                <p className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-foreground">
                  {main.stage} · {main.module}
                  <Link href={`/admin/runs/${main.run_id}`} className="text-[11px] font-normal text-muted-foreground">
                    Trace ↗
                  </Link>
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{main.summary}</p>
                <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-4 text-foreground" data-testid="harness-output">
                  {JSON.stringify(main.output, null, 2)}
                </pre>
              </div>
              {setup.length > 0 ? (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">Setup runs ({setup.map((step) => step.stage).join(", ")})</summary>
                  <ul className="mt-1 grid gap-1">
                    {setup.map((step) => (
                      <li key={step.run_id} className="text-muted-foreground">
                        {step.stage} · {step.module}: {step.summary}{" "}
                        <Link href={`/admin/runs/${step.run_id}`} className="text-foreground">
                          Trace ↗
                        </Link>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </article>
  );
}

/** The admin AI harness (KAN-54): one card per AI use case, run against the live model. */
export function AiHarness({
  cases,
  demoFiles,
  domains,
}: {
  cases: HarnessCase[];
  demoFiles: { id: string; title: string }[];
  domains: { value: string; label: string }[];
}) {
  return (
    <div className="grid gap-3">
      {cases.map((entry) => (
        <HarnessCard key={entry.id} entry={entry} demoFiles={demoFiles} domains={domains} />
      ))}
    </div>
  );
}
