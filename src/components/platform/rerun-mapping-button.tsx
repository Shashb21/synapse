"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAiEnabled } from "@/components/platform/ai-status";
import { CUSTOMER_STAGE_TARGET, type StageRunResponse } from "@/components/platform/run-stage-button";
import { postJson } from "@/lib/post-json";

/**
 * Runs mapping (S4) again for the open workspace (KAN-68), through the customer
 * stage endpoint, so a person can recover from a failed mapping step without
 * the owner console. It follows the mapping section's AI switch: with AI off it
 * shows `aiOffFallback` (the manual path) instead.
 */
export function RerunMappingButton({
  variant = "outline",
  aiOffFallback = null,
  onDone,
}: {
  variant?: "default" | "outline";
  aiOffFallback?: ReactNode;
  onDone?: (ok: boolean) => void;
}) {
  const ai = useAiEnabled("mapping");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!ai) return <>{aiOffFallback}</>;

  async function run() {
    setPending(true);
    setResult(null);
    const res = await postJson(CUSTOMER_STAGE_TARGET.endpoint, { stage: "S4", input: {} });
    const json = res.json as StageRunResponse;
    setPending(false);
    const ok = res.ok;
    setResult(
      ok
        ? { ok, text: "Mapping finished. The table shows the new proposal." }
        : { ok, text: json.error ?? "Mapping couldn't run. Try again." },
    );
    onDone?.(ok);
    if (ok) router.refresh();
  }

  return (
    <div className="grid gap-1">
      <div>
        <Button type="button" size="sm" variant={variant} disabled={pending} onClick={() => void run()}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          {pending ? "Mapping…" : "Re-run mapping"}
        </Button>
      </div>
      {result ? (
        <p
          role={result.ok ? "status" : "alert"}
          className={result.ok ? "text-[11px] text-muted-foreground" : "text-[11px] text-destructive"}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
