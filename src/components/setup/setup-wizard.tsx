"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Brain,
  ChartGantt,
  CheckCircle2,
  ChevronRight,
  Grid2x2,
  Inbox,
  Lightbulb,
  Loader2,
  ShieldCheck,
  SlidersHorizontal,
  Split,
  Upload,
  Workflow,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PlanningContext } from "@/lib/iegp/planning-context";

const STEPS = ["Asset context", "Your journey", "Connect models", "Ready"] as const;

const JOURNEY = [
  {
    stage: "S0–S1",
    title: "Upload & parse",
    detail: "Bring stakeholder interviews and plans in; parse into structured blocks.",
    icon: Upload,
    tone: "var(--chart-1)",
  },
  {
    stage: "S2–S3",
    title: "Gaps & tactics",
    detail: "Agentic extraction proposes evidence gaps and candidate tactics with full trace.",
    icon: Inbox,
    tone: "var(--chart-2)",
  },
  {
    stage: "S4",
    title: "Mapping table",
    detail: "LLM proposes one row per gap (tactics + status); you accept or edit with rationale.",
    icon: Grid2x2,
    tone: "var(--chart-3)",
  },
  {
    stage: "S5–S6",
    title: "Validate & split",
    detail: "Human gates on Gaps: validate status, resolve partials with explicit splits.",
    icon: ShieldCheck,
    tone: "var(--chart-4)",
  },
  {
    stage: "S8",
    title: "Prioritize",
    detail: "Matrix placement uses your asset context, launch timeline, and competitive pressure.",
    icon: Split,
    tone: "var(--chart-5)",
  },
  {
    stage: "S9–S10",
    title: "Ideate & Gantt",
    detail: "Propose tactics for open gaps, then lock the interactive IEGP timeline.",
    icon: ChartGantt,
    tone: "var(--known)",
  },
  {
    stage: "Control",
    title: "OAuth routing",
    detail: "Log in with Grok (default) or Claude (one-click). Per-stage model routing.",
    icon: SlidersHorizontal,
    tone: "var(--chart-1)",
  },
] as const;

export function SetupWizard({
  initial,
  actorName,
  actorFunction,
  setupComplete,
}: {
  initial: PlanningContext;
  actorName: string;
  actorFunction: string;
  setupComplete: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(setupComplete ? 3 : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<PlanningContext>(initial);

  const progress = useMemo(() => ((step + 1) / STEPS.length) * 100, [step]);

  async function save(markComplete: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save_product_setup",
        actor_name: actorName,
        actor_function: actorFunction,
        mark_complete: markComplete,
        context: form,
      }),
    });
    const json = (await res.json()) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Could not save setup");
      return false;
    }
    if (markComplete) router.push("/pipeline");
    else router.refresh();
    return true;
  }

  function field<K extends keyof PlanningContext>(key: K, value: PlanningContext[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <header className="grid gap-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Synapse setup</p>
        <h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">
          Build your Integrated Evidence Generation Plan
        </h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
          A short questionnaire anchors prioritization to your asset. Then we walk the modular pipeline —
          upload through Gantt — and connect live models on the control panel.
        </p>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-[var(--chart-1)] transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <ol className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={cn(
                "rounded-full border px-2 py-0.5",
                index === step
                  ? "border-[var(--chart-1)]/50 text-foreground"
                  : index < step
                    ? "border-[var(--known)]/40 text-foreground"
                    : "border-border",
              )}
            >
              {index < step ? "✓ " : null}
              {label}
            </li>
          ))}
        </ol>
      </header>

      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}

      {step === 0 ? (
        <section className="grid gap-4 rounded-lg border border-border bg-gradient-to-br from-card/80 via-card/40 to-transparent p-5 md:grid-cols-2">
          <div className="grid gap-3">
            <h2 className="text-[15px] font-medium">Asset & indication</h2>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Asset / brand name
              <Input
                value={form.asset_name}
                onChange={(e) => field("asset_name", e.target.value)}
                placeholder="e.g. Velmara"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              INN / molecule
              <Input
                value={form.inn}
                onChange={(e) => field("inn", e.target.value)}
                placeholder="e.g. velmaratinib"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Indication
              <Input
                value={form.indication}
                onChange={(e) => field("indication", e.target.value)}
                placeholder="e.g. 2L EGFR-mutant NSCLC"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Geography
              <Input
                value={form.geography}
                onChange={(e) => field("geography", e.target.value)}
                placeholder="e.g. US + EU5"
              />
            </label>
          </div>
          <div className="grid gap-3">
            <h2 className="text-[15px] font-medium">Company & launch context</h2>
            <p className="text-[11px] text-muted-foreground">
              Fed into S8 prioritization so suggested bands reflect your timeline and competitive story.
            </p>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Lifecycle stage
              <Input
                value={form.lifecycle_stage}
                onChange={(e) => field("lifecycle_stage", e.target.value)}
                placeholder="peri-launch"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Launch timeline
              <Input
                value={form.launch_timeline}
                onChange={(e) => field("launch_timeline", e.target.value)}
                placeholder="US launch 2027-H1; EU5 staggered"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Competitor positioning
              <Input
                value={form.competitor_positioning}
                onChange={(e) => field("competitor_positioning", e.target.value)}
                placeholder="Differentiate vs SoC on CNS / elderly"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Key decision this plan supports
              <Input
                value={form.key_decision}
                onChange={(e) => field("key_decision", e.target.value)}
                placeholder="P&T / HTA filing"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Decision date
              <Input
                type="date"
                value={form.decision_date}
                onChange={(e) => field("decision_date", e.target.value)}
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Strategic importance (1–5)
              <Input
                type="number"
                min={1}
                max={5}
                value={form.strategic_importance}
                onChange={(e) => field("strategic_importance", Number(e.target.value))}
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Company situation (free text)
              <textarea
                className="min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-[13px]"
                value={form.company_situation}
                onChange={(e) => field("company_situation", e.target.value)}
                placeholder="What leadership already knows about evidence risk..."
              />
            </label>
          </div>
        </section>
      ) : null}

      {step === 1 ? (
        <section className="grid gap-4">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Workflow className="size-4" aria-hidden />
            Modular pipeline — each card is an independent stage with its own contract and trace.
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {JOURNEY.map((item) => {
              const Icon = item.icon;
              return (
                <article
                  key={item.stage}
                  className="group relative overflow-hidden border border-border bg-card/50 p-4 transition hover:border-[var(--chart-1)]/30"
                >
                  <div
                    className="pointer-events-none absolute -right-6 -top-6 size-24 rounded-full opacity-20 blur-2xl"
                    style={{ background: item.tone }}
                  />
                  <div className="flex items-start gap-3">
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background/80"
                      style={{ color: item.tone }}
                    >
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{item.stage}</p>
                      <h3 className="text-[14px] font-medium text-foreground">{item.title}</h3>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{item.detail}</p>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Lightbulb className="size-4 shrink-0" aria-hidden />
            Agentic stages run proposer → critic (×3) → judge. Every exchange is observable under Runs.
          </p>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="grid gap-4 rounded-lg border border-border bg-card/40 p-5 md:grid-cols-[1fr_280px]">
          <div className="grid gap-3">
            <h2 className="flex items-center gap-2 text-[15px] font-medium">
              <Brain className="size-4 text-[var(--chart-1)]" aria-hidden />
              Connect live models
            </h2>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Synapse uses OAuth only — no API keys. Built-in public clients start the login flow without
              operator env vars. Default route is <strong className="font-medium text-foreground">Grok</strong>;
              switch every stage to <strong className="font-medium text-foreground">Claude</strong> in one click.
            </p>
            <ul className="grid gap-2 text-[11px] text-muted-foreground">
              <li>Agentic stages block until a provider is connected — no offline fake model.</li>
              <li>Per-stage routing stays in the control panel; fallbacks are other live providers.</li>
            </ul>
            <Link
              href="/control"
              className="inline-flex w-fit items-center gap-1 text-[12px] text-[var(--chart-1)] no-underline hover:underline"
            >
              Open control panel
              <ChevronRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <aside className="grid content-start gap-2 border border-dashed border-border p-3 text-[11px] text-muted-foreground">
            <p className="font-medium text-foreground">Quick checklist</p>
            <p>1. Log in with xAI · Grok (default)</p>
            <p>2. Optional: one-click Claude alternate</p>
            <p>3. Upload demo sources on Pipeline or Upload</p>
          </aside>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="grid gap-4 rounded-lg border border-[var(--known)]/30 bg-[var(--known)]/5 p-6 text-center">
          <CheckCircle2 className="mx-auto size-10 text-[var(--known)]" aria-hidden />
          <h2 className="text-lg font-medium">You are set up</h2>
          <p className="mx-auto max-w-md text-[13px] text-muted-foreground">
            Asset context is saved for prioritization. Head to the pipeline to upload sources, or open Gaps
            after ingest. Revisit this wizard anytime from <strong>Get started</strong> in the sidebar.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/pipeline" className={buttonVariants()}>
              Open pipeline
            </Link>
            <Link href="/control" className={buttonVariants({ variant: "outline" })}>
              Control panel
            </Link>
          </div>
        </section>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <Button
          type="button"
          variant="ghost"
          disabled={step === 0 || busy}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          Back
        </Button>
        <div className="flex flex-wrap gap-2">
          {step < 3 ? (
            <Button
              type="button"
              disabled={busy}
              onClick={async () => {
                const ok = await save(false);
                if (ok) setStep((s) => Math.min(3, s + 1));
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Save & continue
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={() => void save(true)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Mark complete
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
