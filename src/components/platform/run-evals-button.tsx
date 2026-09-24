"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { useAiEnabled } from "@/components/platform/ai-status";

type EvalResponse = {
  error?: string;
  cases?: number;
  passed?: boolean;
  metrics?: { name: string; value: number; target?: number }[];
};

/** Runs the stage's own gold cases. Nothing is written to the domain store. Hidden while AI is off. */
export function RunEvalsButton(props: { stage: string; identity: ActionIdentity }) {
  return useAiEnabled() ? <EvalsButton {...props} /> : null;
}

function EvalsButton({ stage, identity }: { stage: string; identity: ActionIdentity }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<EvalResponse | null>(null);

  async function run() {
    setPending(true);
    setResult(null);
    const res = await fetch("/api/modules/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage,
        actor_name: identity.actor_name,
        actor_function: identity.actor_function,
      }),
    });
    const json = (await res.json()) as EvalResponse;
    setPending(false);
    setResult(res.ok ? json : { error: json.error ?? "Eval run failed" });
    if (res.ok) router.refresh();
  }

  return (
    <div className="grid gap-1">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void run()}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <FlaskConical className="size-3.5" aria-hidden />
        )}
        Run evals
      </Button>
      {result?.error ? (
        <p className="text-[11px] text-destructive">{result.error}</p>
      ) : result?.metrics ? (
        <p className="text-[11px] text-muted-foreground">
          {result.cases} case(s) · {result.passed ? "passed" : "below target"} ·{" "}
          {result.metrics.map((metric) => `${metric.name} ${metric.value}`).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
