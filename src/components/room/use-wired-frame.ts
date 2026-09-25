"use client";

import { useEffect, useRef, type RefObject } from "react";
import { wireFrame, type FrameHooks } from "./present-frame";

/**
 * Keeps a slide iframe chrome-free and reports where it is. Runs on a short
 * timer as well as on load: a soft navigation inside the page keeps the same
 * document, and a frame that loaded before hydration fired no onLoad for us.
 */
export function useWiredFrame(
  ref: RefObject<HTMLIFrameElement | null>,
  hooks: FrameHooks & { onLocation?: (href: string) => void } = {},
  intervalMs = 600,
) {
  const hooksRef = useRef(hooks);
  useEffect(() => {
    hooksRef.current = hooks;
  });

  useEffect(() => {
    const stable: FrameHooks = {
      onMutation: () => hooksRef.current.onMutation?.(),
      onScroll: (ratio) => hooksRef.current.onScroll?.(ratio),
      onKey: (event) => hooksRef.current.onKey?.(event),
    };
    const tick = () => {
      const href = wireFrame(ref.current, stable);
      if (href) hooksRef.current.onLocation?.(href);
    };
    tick();
    const id = window.setInterval(tick, intervalMs);
    const frame = ref.current;
    frame?.addEventListener("load", tick);
    return () => {
      window.clearInterval(id);
      frame?.removeEventListener("load", tick);
    };
  }, [ref, intervalMs]);
}
