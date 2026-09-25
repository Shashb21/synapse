"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  MonitorUp,
  Pause,
  Play,
  RotateCcw,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAiEnabled } from "@/components/platform/ai-status";
import {
  ROOM_SLIDES,
  isShowableHref,
  nextSlideOf,
  presentHref,
  slideById,
  slideIndex,
  stepSlide,
} from "@/lib/room/slides";
import type { RoomState } from "@/lib/room/store";
import { ExportPackButton, type ExportPackData } from "./export-pack";
import { keyStep } from "./keys";
import { isTypingTarget } from "./present-frame";
import { openRoomChannel, postRoom, type RoomMessage } from "./room-channel";
import { useWiredFrame } from "./use-wired-frame";

export type BreakoutSummary = { id: string; name: string; note: string | null; gapCount: number };

export type PresenterConsoleProps = {
  workspaceKey: string;
  workspaceName?: string | null;
  initialState: RoomState;
  initialNotes: Record<string, string>;
  breakouts: BreakoutSummary[];
  exportPack?: ExportPackData;
};

export const AUDIENCE_WINDOW_NAME = "synapse-room-audience";

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function SlideTimer() {
  const [now, setNow] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [pausedAt, setPausedAt] = useState<number | null>(null);

  useEffect(() => {
    const started = Date.now();
    const first = window.setTimeout(() => {
      setStartedAt(started);
      setNow(Date.now());
    }, 0);
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  const elapsed = now && startedAt ? (pausedAt ?? now) - startedAt : 0;
  const clock = now ? new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--";

  return (
    <div className="flex items-center gap-1.5 text-[13px] tabular-nums" aria-label="Timer">
      <span data-testid="room-timer" className="min-w-[4.5ch] font-medium text-foreground">
        {formatElapsed(elapsed)}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={pausedAt ? "Resume timer" : "Pause timer"}
        onClick={() => {
          if (!now || !startedAt) return;
          if (pausedAt) {
            setStartedAt(startedAt + (Date.now() - pausedAt));
            setPausedAt(null);
          } else {
            setPausedAt(Date.now());
          }
        }}
      >
        {pausedAt ? <Play /> : <Pause />}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Reset timer"
        onClick={() => {
          const t = Date.now();
          setStartedAt(t);
          setPausedAt(pausedAt ? t : null);
          setNow(t);
        }}
      >
        <RotateCcw />
      </Button>
      <span className="ml-2 text-muted-foreground" data-testid="room-clock">
        {clock}
      </span>
    </div>
  );
}

/** A scaled, non-interactive live render of a page (the "next slide" pane). */
function SlidePreview({ href, rev, title }: { href: string; rev: number; title: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.25);
  useWiredFrame(frameRef);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / 1280));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={boxRef} className="relative aspect-[16/10] w-full overflow-hidden border border-border bg-card">
      <iframe
        key={`${href}#${rev}`}
        ref={frameRef}
        title={`Next slide: ${title}`}
        src={presentHref(href)}
        tabIndex={-1}
        aria-hidden
        data-testid="room-next-frame"
        data-href={href}
        className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
        style={{ width: 1280, height: 800, transform: `scale(${scale})` }}
      />
    </div>
  );
}

export function PresenterConsole({
  workspaceKey,
  workspaceName,
  initialState,
  initialNotes,
  breakouts,
  exportPack,
}: PresenterConsoleProps) {
  const ai = useAiEnabled();
  const [slideId, setSlideId] = useState(slideById(initialState.slide_id)?.id ?? ROOM_SLIDES[0].id);
  /** What the current frame loads; changes only when the presenter changes slide. */
  const [frameSrc, setFrameSrc] = useState(initialState.href);
  const [location, setLocation] = useState(initialState.href);
  const [notes, setNotes] = useState<Record<string, string>>(initialNotes);
  const [noteStatus, setNoteStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tab, setTab] = useState<"present" | "breakouts">("present");
  const [previewRev, setPreviewRev] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef<RoomState>(initialState);
  const locationRef = useRef(initialState.href);
  const arrivingRef = useRef<string | null>(null);
  const scrollRef = useRef(0);
  const pendingNote = useRef<{ slide_id: string; notes: string } | null>(null);
  const noteTimer = useRef<number | null>(null);
  const bumpTimer = useRef<number | null>(null);

  const index = slideIndex(slideId);
  const slide = ROOM_SLIDES[index];
  const next = nextSlideOf(slideId);

  const publish = useCallback((state: RoomState) => {
    if (state.rev < stateRef.current.rev) return;
    stateRef.current = state;
    channelRef.current?.postMessage({ type: "state", state } satisfies RoomMessage);
  }, []);

  /** Persists a move and tells same-browser audiences at once. */
  const sync = useCallback(
    async (body: Record<string, unknown>, fallback: Omit<RoomState, "rev" | "updated_at">) => {
      try {
        const { state } = await postRoom(body);
        setSyncError(null);
        if (state) publish(state);
      } catch (error) {
        // No server state (e.g. database down): still move same-browser audiences.
        setSyncError(error instanceof Error ? error.message : "Could not save the current slide.");
        publish({ ...fallback, rev: stateRef.current.rev + 1, updated_at: null });
      }
    },
    [publish],
  );

  const flushNote = useCallback(async () => {
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = null;
    const pending = pendingNote.current;
    if (!pending) return;
    pendingNote.current = null;
    setNoteStatus("saving");
    try {
      await postRoom({ op: "note", ...pending });
      setNoteStatus(pendingNote.current ? "saving" : "saved");
    } catch {
      setNoteStatus("error");
    }
  }, []);

  const goTo = useCallback(
    (id: string) => {
      const target = slideById(id);
      if (!target) return;
      void flushNote();
      setSlideId(target.id);
      setFrameSrc(target.href);
      setLocation(target.href);
      locationRef.current = target.href;
      // Until the frame has loaded this slide, its reports belong to the page being left.
      arrivingRef.current = target.href;
      scrollRef.current = 0;
      setNoteStatus("idle");
      void sync({ op: "slide", slide_id: target.id }, { slide_id: target.id, href: target.href });
    },
    [flushNote, sync],
  );

  const endShow = useCallback(() => {
    void flushNote();
    channelRef.current?.postMessage({ type: "end" } satisfies RoomMessage);
    // A full load tears down the live slide frames; End is a hard stop, like PowerPoint's.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/");
  }, [flushNote]);

  const handleStep = useCallback(
    (step: ReturnType<typeof keyStep>) => {
      if (step === null) return;
      if (step === "end") return endShow();
      if (step === "first") return goTo(ROOM_SLIDES[0].id);
      if (step === "last") return goTo(ROOM_SLIDES[ROOM_SLIDES.length - 1].id);
      const target = stepSlide(slideId, step);
      if (target.id !== slideId) goTo(target.id);
    },
    [endShow, goTo, slideId],
  );

  // Keys on the console itself (never while typing notes).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      // Space on a focused button presses that button, as everywhere else.
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (event.key === " " && (tag === "button" || tag === "a")) return;
      const step = keyStep(event.key);
      if (step === null) return;
      if (tab !== "present" && step !== "end") return;
      event.preventDefault();
      handleStep(step);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleStep, tab]);

  // Same-browser audiences: answer hellos, follow their clicker.
  const handleStepRef = useRef(handleStep);
  useEffect(() => {
    handleStepRef.current = handleStep;
  });
  useEffect(() => {
    const channel = openRoomChannel(workspaceKey);
    channelRef.current = channel;
    if (!channel) return;
    channel.onmessage = (event: MessageEvent<RoomMessage>) => {
      const message = event.data;
      if (message.type === "hello") {
        channel.postMessage({ type: "state", state: stateRef.current } satisfies RoomMessage);
        channel.postMessage({ type: "scroll", href: locationRef.current, ratio: scrollRef.current } satisfies RoomMessage);
      } else if (message.type === "nav") {
        handleStepRef.current(message.step);
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [workspaceKey]);

  // The live slide: chrome-free, followed by the audience.
  useWiredFrame(frameRef, {
    onLocation: (href) => {
      if (arrivingRef.current) {
        // A late report from the previous slide's page must not move the show back.
        if (href !== arrivingRef.current) return;
        arrivingRef.current = null;
      }
      if (href === locationRef.current) return;
      if (!isShowableHref(href)) {
        // A link inside the page led to the room itself (or the accuracy tool): go back.
        if (frameRef.current) frameRef.current.src = presentHref(locationRef.current);
        return;
      }
      locationRef.current = href;
      setLocation(href);
      scrollRef.current = 0;
      void sync({ op: "location", href }, { slide_id: slideId, href });
    },
    onMutation: () => {
      if (bumpTimer.current) window.clearTimeout(bumpTimer.current);
      bumpTimer.current = window.setTimeout(() => {
        bumpTimer.current = null;
        setPreviewRev((rev) => rev + 1);
        void sync({ op: "bump" }, { slide_id: slideId, href: locationRef.current });
      }, 350);
    },
    onScroll: (ratio) => {
      scrollRef.current = ratio;
      channelRef.current?.postMessage({ type: "scroll", href: locationRef.current, ratio } satisfies RoomMessage);
    },
    onKey: (event) => {
      // Inside the live page only a clicker's PageUp/PageDown changes slide.
      if (event.key !== "PageDown" && event.key !== "PageUp") return;
      event.preventDefault();
      handleStep(keyStep(event.key));
    },
  });

  useEffect(
    () => () => {
      void flushNote();
    },
    [flushNote],
  );

  function onNotesChange(value: string) {
    setNotes((all) => ({ ...all, [slideId]: value }));
    pendingNote.current = { slide_id: slideId, notes: value };
    setNoteStatus("saving");
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => void flushNote(), 700);
  }

  function openAudience() {
    const win = window.open("/room/audience", AUDIENCE_WINDOW_NAME, "popup=yes,width=1280,height=800");
    win?.focus();
  }

  const noteLabel =
    noteStatus === "saving" ? "Saving…" : noteStatus === "saved" ? "Saved" : noteStatus === "error" ? "Not saved — retry by typing" : "";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background text-foreground" data-testid="presenter-console">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <div className="flex items-baseline gap-2">
          <Link href="/" className="text-[13px] font-medium text-foreground no-underline" title="Back to Prep">
            Synapse IEGP
          </Link>
          <span className="text-[12px] text-muted-foreground">
            Room · Presenter view{workspaceName ? ` · ${workspaceName}` : ""}
          </span>
          {ai ? null : <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">AI off</span>}
        </div>
        <nav className="flex gap-1" aria-label="Room sections">
          <Button size="sm" variant={tab === "present" ? "default" : "ghost"} aria-pressed={tab === "present"} onClick={() => setTab("present")}>
            Present
          </Button>
          <Button size="sm" variant={tab === "breakouts" ? "default" : "ghost"} aria-pressed={tab === "breakouts"} onClick={() => setTab("breakouts")}>
            <Users aria-hidden /> Breakouts
          </Button>
        </nav>
        <SlideTimer />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {exportPack ? <ExportPackButton data={exportPack} /> : null}
          <Button size="sm" variant="outline" onClick={openAudience}>
            <MonitorUp aria-hidden /> Open audience window
          </Button>
          <Button size="sm" variant="ghost" onClick={endShow} title="End show (Esc)">
            <X aria-hidden /> End show
          </Button>
        </div>
      </header>

      {syncError ? (
        <p role="alert" className="border-b border-border bg-destructive/10 px-4 py-1 text-[12px] text-destructive">
          {syncError} Audience windows in this browser still follow; a projector on another machine will not.
        </p>
      ) : null}

      <div className={cn("min-h-0 flex-1 flex-col lg:flex-row", tab === "present" ? "flex" : "hidden")}>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col p-3" aria-label="Current slide">
          <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
            <p>
              <span className="text-muted-foreground">Slide </span>
              <span data-testid="room-slide-position" className="font-medium">
                {index + 1} / {ROOM_SLIDES.length}
              </span>
              <span className="ml-2 text-[15px] font-medium" data-testid="room-slide-title">
                {slide.title}
              </span>
              {location !== slide.href ? (
                <span className="ml-2 text-muted-foreground" data-testid="room-location">
                  {location}
                </span>
              ) : null}
            </p>
            <p className="hidden text-muted-foreground md:block">Edit the page right here — the audience sees it.</p>
          </div>
          <iframe
            ref={frameRef}
            title={`Current slide: ${slide.title}`}
            src={presentHref(frameSrc)}
            data-testid="room-current-frame"
            data-slide-id={slide.id}
            data-href={location}
            className="min-h-0 w-full flex-1 border border-border bg-background"
          />
        </section>

        <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-border p-3 lg:w-[360px] lg:border-l lg:border-t-0">
          <div>
            <p className="mb-1 text-[12px] text-muted-foreground">
              Next{next ? `: ${next.title}` : ""}
            </p>
            {next ? (
              <SlidePreview href={next.href} rev={previewRev} title={next.title} />
            ) : (
              <div className="grid aspect-[16/10] place-items-center border border-border bg-card text-[12px] text-muted-foreground">
                End of slides
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" disabled={index === 0} onClick={() => handleStep(-1)} aria-label="Previous slide">
              <ChevronLeft aria-hidden /> Previous
            </Button>
            <Button className="flex-1" disabled={!next} onClick={() => handleStep(1)} aria-label="Next slide">
              Next <ChevronRight aria-hidden />
            </Button>
          </div>

          <label className="flex min-h-0 flex-1 flex-col gap-1 text-[12px] text-muted-foreground">
            <span className="flex items-center justify-between">
              <span>Speaker notes · {slide.title}</span>
              <span data-testid="room-notes-status" aria-live="polite">
                {noteLabel}
              </span>
            </span>
            <textarea
              aria-label="Speaker notes"
              data-testid="room-notes"
              value={notes[slide.id] ?? ""}
              onChange={(event) => onNotesChange(event.target.value)}
              onBlur={() => void flushNote()}
              placeholder="Only you see these. Saved for this workspace."
              className="min-h-40 flex-1 resize-none rounded-lg border border-input bg-transparent p-2.5 text-[14px] leading-6 text-foreground outline-none focus-visible:border-ring"
            />
          </label>
          <p className="text-[11px] text-muted-foreground">
            → / Space / PageDown next · ← / PageUp previous · Esc ends the show
          </p>
        </aside>
      </div>

      <section className={cn("min-h-0 flex-1 overflow-y-auto p-6", tab === "breakouts" ? "block" : "hidden")} aria-label="Breakouts">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-medium">Breakout groups</h2>
              <p className="text-[12px] text-muted-foreground">
                Open each group&apos;s room in its own window — one per screen.
              </p>
            </div>
            <Link
              href="/breakouts"
              className="inline-flex h-8 items-center rounded-lg border border-input px-2.5 text-[13px] text-foreground no-underline"
            >
              Manage breakout groups
            </Link>
          </div>
          {breakouts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No breakout groups yet. Create them on{" "}
              <Link href="/breakouts" className="text-foreground">
                Breakout groups
              </Link>
              .
            </p>
          ) : (
            <ul className="grid gap-2">
              {breakouts.map((group) => (
                <li key={group.id} className="flex flex-wrap items-center justify-between gap-2 border border-border bg-card p-3">
                  <div>
                    <p className="text-[14px] font-medium">{group.name}</p>
                    {group.note ? <p className="text-[12px] text-muted-foreground">{group.note}</p> : null}
                    <p className="text-[11px] text-muted-foreground">
                      {group.gapCount} gap{group.gapCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Link
                    href={`/breakouts/${group.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center rounded-lg border border-input px-2.5 text-[13px] text-foreground no-underline"
                  >
                    Open room ↗
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <nav className="flex gap-1 overflow-x-auto border-t border-border px-3 py-2" aria-label="Slides">
        {ROOM_SLIDES.map((item, i) => (
          <button
            key={item.id}
            type="button"
            title={item.hint}
            aria-current={item.id === slideId ? "true" : undefined}
            onClick={(event) => {
              event.currentTarget.blur();
              setTab("present");
              goTo(item.id);
            }}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12px]",
              item.id === slideId
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="tabular-nums text-muted-foreground">{i + 1}</span>
            {item.title}
          </button>
        ))}
      </nav>
    </div>
  );
}
