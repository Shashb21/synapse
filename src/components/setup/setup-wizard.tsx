"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import {
  Brain,
  ChartGantt,
  CheckCircle2,
  ChevronRight,
  Grid2x2,
  Hand,
  Inbox,
  Lightbulb,
  Loader2,
  Rocket,
  ShieldCheck,
  Split,
  Upload,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  parsePlanningContext,
  SETUP_SECTIONS,
  setupIssues,
  type PlanningContext,
  type SetupSection,
} from "@/lib/iegp/planning-context";
import { useAiEnabled } from "@/components/platform/ai-status";
import { RestartWalkthroughButton } from "@/components/walkthrough/restart-walkthrough-button";
import { TOUR_STEPS } from "@/components/walkthrough/tour-steps";
import { updateWalkthrough } from "@/components/walkthrough/walkthrough-client";
import {
  AssetStep,
  CompanyStep,
  LandscapeStep,
  ObjectivesStep,
  SettingsStep,
  SetupSummary,
  StakeholdersStep,
  type StepProps,
} from "./setup-steps";

type StepId = "welcome" | SetupSection | "models" | "review";
type Step = { id: StepId; label: string };

const SECTION_VIEWS: Record<SetupSection, (props: StepProps) => ReactNode> = {
  asset: AssetStep,
  company: CompanyStep,
  objectives: ObjectivesStep,
  landscape: LandscapeStep,
  stakeholders: StakeholdersStep,
  settings: SettingsStep,
};

const isSection = (id: StepId): id is SetupSection => SETUP_SECTIONS.some((section) => section.id === id);

/** The steps, in order. A brand-new workspace opens on a welcome step. */
export function wizardSteps(opts: { ai: boolean; isNew: boolean }): Step[] {
  return [
    ...(opts.isNew ? [{ id: "welcome" as const, label: "Welcome" }] : []),
    ...SETUP_SECTIONS.map((section) => ({ id: section.id, label: section.label })),
    opts.ai ? { id: "models" as const, label: "Connect models" } : { id: "models" as const, label: "Work by hand" },
    { id: "review" as const, label: "Review & finish" },
  ];
}

const JOURNEY = [
  { title: "Gaps", detail: "Evidence gaps extracted from your sources, with mapped tactics and computed status.", icon: Inbox },
  { title: "Tactics & mapping", detail: "Which studies answer which gaps, and how well.", icon: Grid2x2 },
  { title: "Validate & split", detail: "Human gates: validate status, resolve partial gaps.", icon: ShieldCheck },
  { title: "Prioritize", detail: "Rank Open gaps per treatment setting, using the context you enter here.", icon: Split },
  { title: "Ideate & timeline", detail: "Propose tactics for open gaps, then date them against your key decisions.", icon: ChartGantt },
] as const;

const MANUAL_JOURNEY = [
  { title: "Add gaps", detail: "Enter each evidence gap by hand. There is no upload or parsing while AI is off.", icon: Inbox },
  { title: "Add tactics", detail: "Enter the studies and activities in your tactic library, and map them to gaps.", icon: Lightbulb },
  { title: "Validate & split", detail: "Validate status on Gaps and split partial gaps by hand.", icon: ShieldCheck },
  { title: "Prioritize", detail: "Place each gap on the matrix yourself, setting by setting.", icon: Split },
  { title: "Ideate & timeline", detail: "Add proposed tactics for open gaps, then place timeline activities.", icon: ChartGantt },
] as const;

function issuesBySection(ctx: PlanningContext) {
  const bySection: Partial<Record<SetupSection, string[]>> = {};
  const byField: Record<string, string> = {};
  for (const issue of setupIssues(ctx)) {
    (bySection[issue.section] ??= []).push(issue.message);
    byField[issue.field] ??= issue.message;
  }
  return { bySection, byField };
}

export function SetupWizard({
  initial,
  actorName,
  actorFunction,
  setupComplete,
  isNew = false,
  workspaceName,
}: {
  initial: PlanningContext;
  actorName: string;
  actorFunction: string;
  setupComplete: boolean;
  /** Just created this workspace (/setup?new=1): open on the welcome step. */
  isNew?: boolean;
  workspaceName?: string;
}) {
  const router = useRouter();
  const ai = useAiEnabled();
  const steps = useMemo(() => wizardSteps({ ai, isNew }), [ai, isNew]);
  const [form, setForm] = useState<PlanningContext>(initial);
  const [complete, setComplete] = useState(setupComplete);
  const [index, setIndex] = useState(() => {
    if (setupComplete) return steps.length - 1;
    if (isNew) return 0;
    if (!initial.saved_at) return 0;
    // Resume a draft at its first section with something missing.
    const { bySection } = issuesBySection(parsePlanningContext(initial));
    const firstOpen = steps.findIndex((step) => isSection(step.id) && bySection[step.id]?.length);
    return firstOpen >= 0 ? firstOpen : steps.length - 1;
  });
  const [attempted, setAttempted] = useState<Set<StepId>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(initial.saved_at || null);

  const step = steps[Math.min(index, steps.length - 1)]!;
  const parsed = useMemo(() => parsePlanningContext(form), [form]);
  const { bySection, byField } = useMemo(() => issuesBySection(parsed), [parsed]);
  const progress = ((index + 1) / steps.length) * 100;

  const set: StepProps["set"] = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  async function save(markComplete: boolean): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
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
      const json = (await res.json()) as { error?: string; context?: PlanningContext };
      if (!res.ok) {
        setError(json.error ?? "Could not save setup");
        return false;
      }
      // New objectives get their ids on save; keep them so the next save updates, not duplicates.
      if (json.context) {
        setForm(json.context);
        setSavedAt(json.context.saved_at || new Date().toISOString());
      }
      if (markComplete) setComplete(true);
      return true;
    } catch {
      setError("Could not reach the server. Your answers are still here; try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    if (isSection(step.id)) {
      setAttempted((prev) => new Set(prev).add(step.id));
      if (bySection[step.id]?.length) return;
      if (!(await save(false))) return;
    }
    setIndex((i) => Math.min(steps.length - 1, i + 1));
  }

  async function finish(withTour: boolean) {
    setAttempted(new Set(steps.map((s) => s.id)));
    if (Object.keys(bySection).length > 0) {
      setError("Some required answers are missing. Fix the sections marked below.");
      return;
    }
    const firstTime = !complete;
    if (!(await save(true))) return;
    if (withTour) {
      await updateWalkthrough("start", 0);
      router.push(TOUR_STEPS[0]!.href);
    } else if (firstTime) {
      router.push(ai ? "/pipeline" : "/?place=gaps");
    } else {
      router.refresh();
    }
  }

  const jump = (id: StepId) => {
    const at = steps.findIndex((s) => s.id === id);
    if (at >= 0) setIndex(at);
  };
  const errorsFor = (id: StepId) => (attempted.has(id) ? byField : {});
  const journey = ai ? JOURNEY : MANUAL_JOURNEY;
  const SectionView = isSection(step.id) ? SECTION_VIEWS[step.id] : null;

  return (
    <div className="mx-auto grid max-w-5xl gap-8" data-testid="setup-wizard">
      <header className="grid gap-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          IEGP setup{workspaceName ? ` · ${workspaceName}` : ""}
        </p>
        <h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">
          {form.asset_name ? `${form.asset_name} evidence plan` : "Set up this Integrated Evidence Generation Plan"}
        </h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-muted-foreground">
          {ai
            ? "Capture this plan's context: asset, objectives and decisions, evidence landscape and people. Prioritization, ideation and the timeline use it throughout."
            : "Capture this plan's context: asset, objectives and decisions, evidence landscape and people. AI is off, so there is no upload: after setup you start with Add gaps and Add tactics and do every step by hand."}
        </p>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-[var(--chart-1)] transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>
        <ol className="flex flex-wrap gap-2 text-[11px] text-muted-foreground" aria-label="Setup steps">
          {steps.map((item, i) => {
            const flagged = isSection(item.id) && attempted.has(item.id) && Boolean(bySection[item.id]?.length);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-current={i === index ? "step" : undefined}
                  className={cn(
                    "rounded-full border px-2 py-0.5",
                    i === index
                      ? "border-[var(--chart-1)]/50 text-foreground"
                      : flagged
                        ? "border-destructive/60 text-destructive"
                        : i < index
                          ? "border-[var(--known)]/40 text-foreground"
                          : "border-border",
                  )}
                >
                  {i < index && !flagged ? "✓ " : null}
                  {item.label}
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      {step.id === "welcome" ? (
        <section data-testid="setup-step-welcome" className="grid gap-5 rounded-lg border border-[var(--chart-1)]/30 bg-[var(--chart-1)]/5 p-6">
          <div className="flex items-start gap-3">
            <Rocket className="mt-0.5 size-6 shrink-0 text-[var(--chart-1)]" aria-hidden />
            <div className="grid gap-1">
              <h2 className="text-lg font-medium">Welcome to your new workspace</h2>
              <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                This workspace holds one Integrated Evidence Generation Plan. The next six short steps capture its context:
                the asset, the company and plan, strategic objectives and key decisions, the evidence landscape, the people
                involved and the treatment settings. Everything is saved to this workspace only; you can save and come back,
                and edit it any time from Get started. Afterwards a short walkthrough shows you around.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {journey.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.title} className="grid content-start gap-1 border border-border bg-card/50 p-3">
                  <Icon className="size-4 text-[var(--chart-1)]" aria-hidden />
                  <h3 className="text-[13px] font-medium text-foreground">{item.title}</h3>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{item.detail}</p>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {SectionView ? <SectionView form={form} set={set} errors={errorsFor(step.id)} /> : null}

      {step.id === "models" && !ai ? (
        <section className="grid gap-4 rounded-lg border border-border bg-card/40 p-5 md:grid-cols-[1fr_280px]" data-testid="setup-ai-off">
          <div className="grid gap-3">
            <h2 className="flex items-center gap-2 text-[15px] font-medium">
              <Hand className="size-4 text-[var(--chart-1)]" aria-hidden />
              AI is off — you work by hand
            </h2>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              An admin has switched AI off in the control panel. No model is called and nothing is uploaded or parsed. You
              enter gaps and tactics yourself; every later step has a manual form. The context you entered still guides
              your own prioritization and the timeline&apos;s decision dates.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/?place=gaps" className={buttonVariants({ size: "sm" })}>
                Add gaps
              </Link>
              <Link href="/tactics" className={buttonVariants({ size: "sm", variant: "outline" })}>
                Add tactics
              </Link>
            </div>
          </div>
          <aside className="grid content-start gap-2 border border-dashed border-border p-3 text-[11px] text-muted-foreground">
            <p className="font-medium text-foreground">Quick checklist</p>
            <p>1. Add your evidence gaps</p>
            <p>2. Add the tactics in your library</p>
            <p>3. Map tactics to gaps on the mapping table</p>
          </aside>
        </section>
      ) : null}

      {step.id === "models" && ai ? (
        <section className="grid gap-4 rounded-lg border border-border bg-card/40 p-5 md:grid-cols-[1fr_280px]">
          <div className="grid gap-3">
            <h2 className="flex items-center gap-2 text-[15px] font-medium">
              <Brain className="size-4 text-[var(--chart-1)]" aria-hidden />
              Connect live models
            </h2>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Synapse uses OAuth only — no API keys. Default route is <strong className="font-medium text-foreground">Grok</strong>;
              switch every stage to <strong className="font-medium text-foreground">Claude</strong> in one click. The
              context from this wizard is sent with prioritization, ideation and timeline requests.
            </p>
            <Link href="/control" className="inline-flex w-fit items-center gap-1 text-[12px] text-[var(--chart-1)] no-underline hover:underline">
              Open control panel
              <ChevronRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <aside className="grid content-start gap-2 border border-dashed border-border p-3 text-[11px] text-muted-foreground">
            <p className="font-medium text-foreground">Quick checklist</p>
            <p>1. Log in with xAI · Grok (default)</p>
            <p>2. Optional: one-click Claude alternate</p>
            <p className="flex items-center gap-1">
              <Upload className="size-3" aria-hidden /> 3. Upload demo sources on Pipeline or Upload
            </p>
          </aside>
        </section>
      ) : null}

      {step.id === "review" ? (
        <section className="grid gap-4" data-testid="setup-step-review">
          <div
            className={cn(
              "grid gap-2 rounded-lg border p-5",
              complete ? "border-[var(--known)]/30 bg-[var(--known)]/5" : "border-border bg-card/40",
            )}
          >
            <h2 className="flex items-center gap-2 text-[15px] font-medium">
              {complete ? <CheckCircle2 className="size-5 text-[var(--known)]" aria-hidden /> : null}
              {complete ? "This plan is set up" : "Review and finish"}
            </h2>
            <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
              {complete
                ? "The context below is saved for this workspace. Edit any section and save; the stages pick the changes up on their next run."
                : "Check the context below, then finish. A short walkthrough of the main places follows."}{" "}
              {ai
                ? "Next, upload sources on the pipeline, or open Gaps after ingest."
                : "AI is off, so next you add gaps and tactics by hand."}
            </p>
            <div className="flex flex-wrap gap-2">
              {ai ? (
                <>
                  <Link href="/pipeline" className={buttonVariants({ size: "sm", variant: "outline" })}>
                    Open pipeline
                  </Link>
                  <Link href="/control" className={buttonVariants({ size: "sm", variant: "ghost" })}>
                    Control panel
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/?place=gaps" className={buttonVariants({ size: "sm", variant: "outline" })}>
                    Add gaps
                  </Link>
                  <Link href="/tactics" className={buttonVariants({ size: "sm", variant: "ghost" })}>
                    Add tactics
                  </Link>
                </>
              )}
              {complete ? <RestartWalkthroughButton variant="ghost" /> : null}
            </div>
          </div>
          <SetupSummary form={parsed} onEdit={jump} issues={attempted.has("review") ? bySection : {}} />
        </section>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" disabled={index === 0 || busy} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
            Back
          </Button>
          <span className="text-[11px] text-muted-foreground" data-testid="setup-saved-at">
            {savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : "Not saved yet"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {step.id !== "welcome" ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void save(false)}>
              Save &amp; continue later
            </Button>
          ) : null}
          {step.id === "review" ? (
            complete ? (
              <Button type="button" disabled={busy} onClick={() => void finish(false)}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Save changes
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void finish(false)}>
                  Finish without tour
                </Button>
                <Button type="button" disabled={busy} onClick={() => void finish(true)}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Finish &amp; start walkthrough
                </Button>
              </>
            )
          ) : (
            <Button type="button" disabled={busy} onClick={() => void next()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {step.id === "welcome" ? "Get started" : "Continue"}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
