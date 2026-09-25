"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAiEnabled } from "@/components/platform/ai-status";
import { findTourTarget, onStepPage, TOUR_STEPS } from "./tour-steps";
import { WalkthroughCard } from "./walkthrough-card";
import {
  fetchWalkthrough,
  updateWalkthrough,
  WALKTHROUGH_EVENT,
  type WalkthroughProgress,
} from "./walkthrough-client";

/** Pages where the tour never shows (signing in, choosing a workspace). */
const HIDDEN_PREFIXES = ["/login", "/signin", "/auth", "/workspaces", "/select-workspace"];

type Box = { top: number; left: number; width: number; height: number };

function useHighlight(active: boolean, stepIndex: number) {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!active) return;
    const step = TOUR_STEPS[stepIndex]!;
    let el: HTMLElement | null = null;
    let tries = 0;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!el || !el.isConnected) return setBox(null);
        const r = el.getBoundingClientRect();
        setBox({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
      });
    };
    // Pages render their controls after data loads, so look for a few seconds.
    const poll = window.setInterval(() => {
      tries += 1;
      el = findTourTarget(step);
      if (el) {
        window.clearInterval(poll);
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        measure();
      } else if (tries > 16) {
        window.clearInterval(poll);
        setBox(null);
      }
    }, 200);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(poll);
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      setBox(null);
    };
  }, [active, stepIndex]);
  return active ? box : null;
}

function Host() {
  const ai = useAiEnabled();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const search = useSearchParams();
  const [progress, setProgress] = useState<WalkthroughProgress | null>(null);

  useEffect(() => {
    let live = true;
    void fetchWalkthrough().then((loaded) => {
      if (live && loaded) setProgress((prev) => prev ?? loaded);
    });
    const onChange = (event: Event) => setProgress((event as CustomEvent<WalkthroughProgress>).detail);
    window.addEventListener(WALKTHROUGH_EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(WALKTHROUGH_EVENT, onChange);
    };
  }, []);

  const hidden = HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const active = progress?.status === "active" && !hidden;
  const stepIndex = Math.min(progress?.step ?? 0, TOUR_STEPS.length - 1);
  const step = TOUR_STEPS[stepIndex]!;
  const onPage = onStepPage(step, pathname, new URLSearchParams(search?.toString() ?? ""));
  const box = useHighlight(active && onPage, stepIndex);

  const go = useCallback(
    async (index: number) => {
      await updateWalkthrough("step", index);
      router.push(TOUR_STEPS[index]!.href);
    },
    [router],
  );

  if (!active) return null;
  return (
    <>
      {box ? (
        <div
          aria-hidden
          data-testid="walkthrough-highlight"
          className="pointer-events-none fixed z-[55] rounded-lg ring-2 ring-[var(--chart-1)] ring-offset-2 ring-offset-background shadow-[0_0_0_9999px_rgb(0_0_0/0.35)] transition-all duration-300"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      ) : null}
      <WalkthroughCard
        step={stepIndex}
        ai={ai}
        onPage={onPage}
        highlighted={Boolean(box)}
        onBack={() => void go(Math.max(0, stepIndex - 1))}
        onNext={() => {
          if (stepIndex >= TOUR_STEPS.length - 1) void updateWalkthrough("finish", stepIndex);
          else void go(stepIndex + 1);
        }}
        onGo={() => router.push(step.href)}
        onDismiss={() => void updateWalkthrough("dismiss", stepIndex)}
      />
    </>
  );
}

/**
 * Mount once, in the root layout. Shows the tour while this person's progress
 * in the current workspace is `active`, on whichever page they are on.
 */
export function WalkthroughHost() {
  return (
    <Suspense fallback={null}>
      <Host />
    </Suspense>
  );
}
