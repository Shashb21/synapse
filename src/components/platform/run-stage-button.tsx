"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import { useAiEnabled } from "@/components/platform/ai-status";
import { stageNeedsAi } from "@/modules/kernel/stage-ai";

export type StageRunResponse = {
  ok?: boolean;
  code?: string;
  error?: string;
  run_id?: string;
  summary?: string;
  mode?: "llm" | "deterministic";
};

/** Runs one stage through the kernel and reports what came back, inline. */
export function RunStageButton({
  stage,
  input,
  label,
  identity,
  variant = "outline",
  onDone,
  aiOffFallback = null,
}: {
  stage: string;
  input?: Record<string, unknown>;
  label?: string;
  identity: ActionIdentity;
  variant?: "default" | "outline" | "ghost" | "secondary";
  onDone?: (result: StageRunResponse) => void;
  /** Shown instead of the button when AI is off and this stage needs AI. */
  aiOffFallback?: ReactNode;
}) {
  const ai = useAiEnabled();
  if (!ai && stageNeedsAi(stage)) return <>{aiOffFallback}</>;
  return (
    <StageButton
      stage={stage}
      input={input}
      label={label}
      identity={identity}
      variant={variant}
      onDone={onDone}
    />
  );
}

function StageButton({
  stage,
  input,
  label,
  identity,
  variant,
  onDone,
}: {
  stage: string;
  input?: Record<string, unknown>;
  label?: string;
  identity: ActionIdentity;
  variant: "default" | "outline" | "ghost" | "secondary";
  onDone?: (result: StageRunResponse) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<StageRunResponse | null>(null);

  async function run() {
    setPending(true);
    setResult(null);
    const res = await fetch("/api/modules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage,
        input: input ?? {},
        actor_name: identity.actor_name,
        actor_function: identity.actor_function,
      }),
    });
    const json = (await res.json()) as StageRunResponse;
    setPending(false);
    setResult(res.ok ? json : { error: json.error ?? "Stage run failed" });
    onDone?.(json);
    if (res.ok) router.refresh();
  }

  return (
    <div className="grid gap-1">
      <Button size="sm" variant={variant} disabled={pending} onClick={() => void run()}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Play className="size-3.5" aria-hidden />
        )}
        {label ?? `Run ${stage}`}
      </Button>
      {result?.error ? (
        <p className="text-[11px] text-destructive">{result.error}</p>
      ) : result?.summary ? (
        <p className="text-[11px] text-muted-foreground">
          {result.summary}
          {result.mode ? ` · ${result.mode === "llm" ? "LLM route" : "no model call"}` : ""}
        </p>
      ) : null}
    </div>
  );
}
