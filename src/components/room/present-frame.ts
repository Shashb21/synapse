"use client";

import { stripPresent } from "@/lib/room/slides";

/**
 * A slide is the real page in a same-origin iframe. The shells are not ours to
 * change, so the room hides their chrome by adding one stylesheet to the framed
 * document only (never an attribute on <html>: that would break hydration). `?present=1` is also on the URL: once the shells read
 * it (or tag their chrome `data-app-chrome`), this CSS becomes a no-op backstop.
 */
export const PRESENT_CSS = `
[data-app-chrome],
.min-h-full.bg-background > aside.sticky,
.min-h-full.bg-background > div > header.sticky,
[role="status"][aria-label="Prep readiness"],
[data-testid="ai-off-banner"] { display: none !important; }
main { max-width: 1400px !important; }
`;

type FrameWindow = Window & {
  __roomWired?: boolean;
  __roomSubmitted?: boolean;
};

export type FrameHooks = {
  /** A write (POST/PUT/PATCH/DELETE) from the page finished: the audience should refresh. */
  onMutation?: () => void;
  /** The page scrolled; 0 = top, 1 = bottom. */
  onScroll?: (ratio: number) => void;
  /** A key pressed inside the page that is not typing (PageUp/PageDown for clickers). */
  onKey?: (event: KeyboardEvent) => void;
};

function frameWindow(frame: HTMLIFrameElement | null): FrameWindow | null {
  try {
    const win = frame?.contentWindow as FrameWindow | null;
    if (!win || !win.document || win.location.href === "about:blank") return null;
    return win;
  } catch {
    return null; // not same-origin (should not happen)
  }
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

export function scrollRatioOf(doc: Document): number {
  const el = doc.scrollingElement ?? doc.documentElement;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

export function applyScrollRatio(frame: HTMLIFrameElement | null, ratio: number) {
  const win = frameWindow(frame);
  if (!win) return;
  const el = win.document.scrollingElement ?? win.document.documentElement;
  el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight);
}

/**
 * Marks the framed page chrome-free and wires it once per document. Idempotent:
 * call it on load and on a timer (a soft navigation keeps the same document).
 * Returns the page path it is showing (without the present flag), or null.
 */
export function wireFrame(frame: HTMLIFrameElement | null, hooks: FrameHooks = {}): string | null {
  const win = frameWindow(frame);
  if (!win) return null;
  const doc = win.document;
  if (doc.head && !doc.getElementById("room-present-css")) {
    const style = doc.createElement("style");
    style.id = "room-present-css";
    style.textContent = PRESENT_CSS;
    doc.head.appendChild(style);
  }
  if (!win.__roomWired) {
    win.__roomWired = true;
    const original = win.fetch.bind(win);
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      const method = (
        init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
      ).toUpperCase();
      if (method !== "GET" && method !== "HEAD" && response.ok) hooks.onMutation?.();
      return response;
    };
    // A plain form post reloads the frame; the next wire reports it as a write.
    doc.addEventListener("submit", () => {
      try {
        frame!.dataset.roomSubmitted = "1";
      } catch {
        // frame gone
      }
    }, true);
    let queued = false;
    win.addEventListener(
      "scroll",
      () => {
        if (queued) return;
        queued = true;
        win.requestAnimationFrame(() => {
          queued = false;
          hooks.onScroll?.(scrollRatioOf(doc));
        });
      },
      { passive: true },
    );
    doc.addEventListener("keydown", (event) => {
      if (isTypingTarget(event.target)) return;
      hooks.onKey?.(event);
    });
    if (frame?.dataset.roomSubmitted) {
      delete frame.dataset.roomSubmitted;
      hooks.onMutation?.();
    }
  }
  return stripPresent(`${win.location.pathname}${win.location.search}`);
}
