"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

const STEPS = [
  { id: 1, label: "Upload", hint: "Ingest sources" },
  { id: 2, label: "Review", hint: "Gaps and tactics" },
  { id: 3, label: "Prioritize", hint: "You lock the band" },
] as const;

export function Wizard({
  initialStep,
  hasSources,
  upload,
  review,
  prioritize,
  enterPlan,
}: {
  initialStep: 1 | 2 | 3;
  hasSources: boolean;
  upload: React.ReactNode;
  review: React.ReactNode;
  prioritize: React.ReactNode;
  enterPlan: React.ReactNode;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(initialStep);

  function go(next: 1 | 2 | 3) {
    if (next > 1 && !hasSources) return;
    setStep(next);
  }

  return (
    <div>
      <ol className="mb-8 grid gap-2 sm:grid-cols-3">
        {STEPS.map((s) => {
          const active = step === s.id;
          const locked = s.id > 1 && !hasSources;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => go(s.id)}
                disabled={locked}
                className={`w-full border px-3 py-2 text-left ${
                  active
                    ? "border-foreground bg-card text-foreground"
                    : "border-border bg-card/40 text-muted-foreground"
                } ${locked ? "cursor-not-allowed opacity-50" : "hover:border-foreground/40"}`}
              >
                <span className="block text-[13px] font-medium">
                  {s.id}. {s.label}
                </span>
                <span className="mt-0.5 block text-[11px]">{s.hint}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {step === 1 ? upload : null}
      {step === 2 ? review : null}
      {step === 3 ? (
        <>
          {prioritize}
          <div className="mt-8 border border-border bg-card/40 p-4">
            <h2 className="text-[15px] font-medium text-foreground">Enter the plan</h2>
            <p className="mt-1 mb-3 text-[12px] text-muted-foreground">
              After this you live on the plan. Leftover candidates and anything extracted later
              land in the inbox on that page.
            </p>
            {enterPlan}
          </div>
        </>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {step > 1 ? (
          <Button type="button" size="sm" variant="outline" onClick={() => go((step - 1) as 1 | 2)}>
            Back
          </Button>
        ) : null}
        {step < 3 ? (
          <Button
            type="button"
            size="sm"
            onClick={() => go((step + 1) as 2 | 3)}
            disabled={step === 1 && !hasSources}
          >
            Next
          </Button>
        ) : null}
      </div>
      {step === 1 && !hasSources ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          Ingest at least one source to continue.
        </p>
      ) : null}
    </div>
  );
}
