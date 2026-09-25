"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize } from "lucide-react";
import { presentHref } from "@/lib/room/slides";
import type { RoomState } from "@/lib/room/store";
import { applyScrollRatio, isTypingTarget, wireFrame } from "./present-frame";
import { openRoomChannel, type RoomMessage } from "./room-channel";
import { keyStep } from "./keys";

type Frame = { key: number; href: string };

const POLL_MS = 2500;

/**
 * The audience window: the presenter's current page, chrome-free, full-bleed.
 * Follows the presenter over BroadcastChannel (same browser, instant) and by
 * polling /api/room (a projector on another machine). A new page or a refresh
 * loads into a hidden frame and swaps in once it is ready, so the room never
 * sees a blank screen or the app chrome.
 */
export function AudienceView({ workspaceKey, initialState }: { workspaceKey: string; initialState: RoomState }) {
  const [shown, setShown] = useState<Frame>({ key: 0, href: initialState.href });
  const [pending, setPending] = useState<Frame | null>(null);
  const [ended, setEnded] = useState(false);
  const revRef = useRef(initialState.rev);
  const hrefRef = useRef(initialState.href);
  const keyRef = useRef(0);
  const scrollRef = useRef<{ href: string; ratio: number } | null>(null);
  const frames = useRef(new Map<number, HTMLIFrameElement>());
  const channelRef = useRef<BroadcastChannel | null>(null);

  const apply = useCallback((state: RoomState) => {
    if (state.rev <= revRef.current) return;
    revRef.current = state.rev;
    if (state.href !== hrefRef.current) scrollRef.current = null;
    hrefRef.current = state.href;
    keyRef.current += 1;
    setEnded(false);
    setPending({ key: keyRef.current, href: state.href });
  }, []);

  useEffect(() => {
    const channel = openRoomChannel(workspaceKey);
    channelRef.current = channel;
    if (channel) {
      channel.onmessage = (event: MessageEvent<RoomMessage>) => {
        const message = event.data;
        if (message.type === "state") apply(message.state);
        else if (message.type === "end") setEnded(true);
        else if (message.type === "scroll" && message.href === hrefRef.current) {
          scrollRef.current = { href: message.href, ratio: message.ratio };
          for (const frame of frames.current.values()) applyScrollRatio(frame, message.ratio);
        }
      };
      channel.postMessage({ type: "hello" } satisfies RoomMessage);
    }
    return () => {
      channel?.close();
      channelRef.current = null;
    };
  }, [apply, workspaceKey]);

  useEffect(() => {
    let stopped = false;
    const id = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/room", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const json = (await res.json()) as { state?: RoomState };
        if (json.state) apply(json.state);
      } catch {
        // offline for a moment: the next poll catches up
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [apply]);

  // Keep every frame chrome-free (soft navigations keep the document).
  useEffect(() => {
    const id = window.setInterval(() => {
      for (const frame of frames.current.values()) wireFrame(frame);
    }, 600);
    return () => window.clearInterval(id);
  }, []);

  // A clicker plugged into the projector machine still drives the deck.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if (event.key === "f" || event.key === "F") {
        void document.documentElement.requestFullscreen?.().catch(() => undefined);
        return;
      }
      const step = keyStep(event.key);
      if (typeof step !== "number") return;
      event.preventDefault();
      channelRef.current?.postMessage({ type: "nav", step } satisfies RoomMessage);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onFrameLoad(frame: Frame) {
    const el = frames.current.get(frame.key) ?? null;
    wireFrame(el);
    if (scrollRef.current?.href === frame.href) applyScrollRatio(el, scrollRef.current.ratio);
    if (pending?.key === frame.key) {
      setShown(frame);
      setPending(null);
    }
  }

  const list = pending ? [shown, pending] : [shown];

  return (
    <div className="fixed inset-0 z-50 bg-background" data-testid="audience-view">
      {list.map((frame) => {
        const visible = frame.key === shown.key;
        return (
          <iframe
            key={frame.key}
            ref={(el) => {
              if (el) frames.current.set(frame.key, el);
              else frames.current.delete(frame.key);
            }}
            title={visible ? "Presentation" : "Next page (loading)"}
            src={presentHref(frame.href)}
            onLoad={() => onFrameLoad(frame)}
            data-testid={visible ? "audience-frame" : "audience-frame-loading"}
            data-href={frame.href}
            aria-hidden={visible ? undefined : true}
            tabIndex={visible ? undefined : -1}
            className={visible ? "absolute inset-0 h-full w-full border-0" : "invisible absolute inset-0 h-full w-full border-0"}
          />
        );
      })}
      {ended ? (
        <div className="absolute inset-0 grid place-items-center bg-black text-[14px] text-white/70" data-testid="audience-ended">
          End of slide show.
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
        className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-background/80 px-2 py-1 text-[12px] text-muted-foreground opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
        title="Full screen (F)"
      >
        <Maximize className="size-3.5" aria-hidden /> Full screen
      </button>
    </div>
  );
}
