"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TOUR_STEPS } from "./tour-steps";
import { updateWalkthrough } from "./walkthrough-client";

/**
 * Starts the walkthrough again from its first step (Gaps) and opens that page.
 * For the nav: `variant="link"` renders a plain sidebar-style text button.
 */
export function RestartWalkthroughButton({
  label = "Restart walkthrough",
  variant = "outline",
  size = "sm",
  className,
}: {
  label?: string;
  variant?: "outline" | "ghost" | "default" | "link";
  size?: "sm" | "default" | "xs";
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    await updateWalkthrough("restart");
    setBusy(false);
    router.push(TOUR_STEPS[0]!.href);
  };
  if (variant === "link") {
    return (
      <button
        type="button"
        data-testid="restart-walkthrough"
        disabled={busy}
        onClick={() => void start()}
        className={cn("inline-flex items-center gap-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50", className)}
      >
        <Compass className="size-3.5 shrink-0" aria-hidden />
        {label}
      </button>
    );
  }
  return (
    <Button type="button" data-testid="restart-walkthrough" variant={variant} size={size} disabled={busy} onClick={() => void start()} className={className}>
      <Compass className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}
