"use client";

import { ChevronLeft, ChevronRight, Hand, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TOUR_STEPS } from "./tour-steps";

/** The tour's floating card: where you are, what to do here, and how to move on. */
export function WalkthroughCard({
  step,
  ai,
  onPage,
  highlighted,
  onBack,
  onNext,
  onGo,
  onDismiss,
}: {
  step: number;
  ai: boolean;
  /** The browser is on this step's page. */
  onPage: boolean;
  /** A control is highlighted on the page. */
  highlighted: boolean;
  onBack: () => void;
  onNext: () => void;
  onGo: () => void;
  onDismiss: () => void;
}) {
  const current = TOUR_STEPS[Math.min(step, TOUR_STEPS.length - 1)]!;
  const last = step >= TOUR_STEPS.length - 1;
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="walkthrough-title"
      data-testid="walkthrough"
      data-step={current.id}
      className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] right-4 z-[60] grid w-[min(360px,calc(100vw-2rem))] gap-3 rounded-lg border border-[var(--chart-1)]/40 bg-popover p-4 text-popover-foreground shadow-2xl"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {ai ? <Sparkles className="size-3" aria-hidden /> : <Hand className="size-3" aria-hidden />}
            Walkthrough · {step + 1} of {TOUR_STEPS.length} · {current.place}
          </p>
          <h2 id="walkthrough-title" className="text-[14px] font-medium">
            {current.title}
          </h2>
        </div>
        <button
          type="button"
          aria-label="Close walkthrough"
          onClick={onDismiss}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <p className="text-[12px] leading-relaxed text-muted-foreground">{ai ? current.ai : current.manual}</p>
      {onPage && !highlighted ? (
        <p className="text-[11px] text-muted-foreground/80">This control appears once the stage has something to show.</p>
      ) : null}
      <ol className="flex gap-1" aria-label="Tour progress">
        {TOUR_STEPS.map((item, index) => (
          <li
            key={item.id}
            title={item.place}
            className={cn(
              "h-1 flex-1 rounded-full",
              index < step ? "bg-[var(--known)]" : index === step ? "bg-[var(--chart-1)]" : "bg-muted",
            )}
          />
        ))}
      </ol>
      <footer className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          Skip tour
        </Button>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" variant="outline" disabled={step === 0} onClick={onBack}>
            <ChevronLeft className="size-3.5" aria-hidden />
            Back
          </Button>
          {onPage ? (
            <Button type="button" size="sm" onClick={onNext}>
              {last ? "Finish" : `Next: ${TOUR_STEPS[step + 1]!.place}`}
              {last ? null : <ChevronRight className="size-3.5" aria-hidden />}
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={onGo}>
              Open {current.place}
              <ChevronRight className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </footer>
    </aside>
  );
}
