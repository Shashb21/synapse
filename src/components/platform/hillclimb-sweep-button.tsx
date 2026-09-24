"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StageId } from "@/modules/kernel/contracts";
import { useAiEnabled } from "@/components/platform/ai-status";

/** Scores prompt variants against gold. Prompts only matter to a model, so this is hidden while AI is off. */
export function HillclimbSweepButton({ stage }: { stage: StageId }) {
  return useAiEnabled() ? <SweepButton stage={stage} /> : null;
}

function SweepButton({ stage }: { stage: StageId }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSweep() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await fetch("/api/modules/hillclimb", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage, actor_name: "Operator", actor_function: "medical_affairs" }),
    });
    const json = (await res.json()) as { error?: string; champion?: string };
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
