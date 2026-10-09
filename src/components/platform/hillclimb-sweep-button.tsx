"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StageId } from "@/modules/kernel/contracts";
import { useAiEnabled } from "@/components/platform/ai-status";
import type { StageTarget } from "@/components/platform/run-stage-button";
import { postJson } from "@/lib/post-json";

/** Scores prompt variants against gold. Prompts only matter to a model, so this is hidden while AI is off. */
export function HillclimbSweepButton({ stage, target }: { stage: StageId; target?: StageTarget }) {
  return useAiEnabled() ? <SweepButton stage={stage} target={target} /> : null;
}

function SweepButton({
  stage,
  target = { endpoint: "/api/modules/hillclimb" },
}: {
  stage: StageId;
  target?: StageTarget;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSweep() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await postJson(target.endpoint, {
        stage,
        actor_name: "Operator",
        actor_function: "medical_affairs",
        ...(target.workspace_id ? { workspace_id: target.workspace_id } : {}),
      });
    const json = res.json as { error?: string; champion?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Sweep failed");
      return;
    }
    setMessage(`Champion prompt: ${json.champion ?? "—"}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void runSweep()}>
        {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        Hillclimb {stage}
      </Button>
      {message ? <span className="text-[11px] text-muted-foreground">{message}</span> : null}
      {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
    </div>
  );
}
