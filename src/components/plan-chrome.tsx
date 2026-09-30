"use client";

import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { useState } from "react";
import {
  ChartGantt,
  ClipboardList,
  Columns3,
  ListChecks,
  Hourglass,
  Menu,
  Rocket,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAiEnabled } from "@/components/platform/ai-status";
import type { PlanPlace } from "@/lib/iegp/engine";
import { RestartWalkthroughButton } from "@/components/walkthrough";
import { WorkspaceTag } from "@/components/workspaces/workspace-tag";
import { ThemeToggle } from "@/components/theme-toggle";
import type { WorkspaceTagModel } from "@/components/workspaces/model";

export type ShellId =
  | PlanPlace
  | "needs"
  | "gaps"
  | "tactics"
  | "residuals"
  | "roadmap"
  | "sources"
  | "matrix"
  | "ideation"
  | "timeline"
  | "breakouts"
  | "presentation"
  | "pipeline"
  | "runs"
  | "control"
  | "evals"
  | "sdlc"
  | "setup"
  | "mappings";

export type PlanNavModel = {
  gapsCount: number;
  unvalidatedCount: number;
  partialCount: number;
  gapsUnlocked: boolean;
  planUnlocked: boolean;
  tacticsUnlocked: boolean;
  setupComplete: boolean;
  readyForPrioritize: boolean;
  /** Open gaps and how many have a validated band. Left out when it could not be loaded. */
  prioritized?: { validated: number; open: number };
};

/**
 * The strip's one-line verdict: the real next step, not a stage the plan has
 * already passed. Before Prioritize it says whether Gaps is done; after, it
 * shows how far prioritization has got and whether Tactics is open.
 */
export function readinessText(nav: PlanNavModel): string {
  const progress = nav.prioritized;
  const counted = progress && progress.open > 0 ? `${progress.validated} of ${progress.open} validated` : null;
  // Past Prioritize: a gap added or reopened since shows in the counts, not as a step back.
  if (nav.tacticsUnlocked) return counted ? `${counted} · Tactics open` : "Tactics open";
  if (!nav.readyForPrioritize) return "Not ready for Prioritize";
  if (!counted || progress!.validated === 0) return "Ready for Prioritize";
  if (progress!.validated === progress!.open) return `${counted} · Ready for Tactics`;
  return `Prioritizing · ${counted}`;
}

type PlaceId = PlanPlace | "timeline" | "setup" | "mappings" | "breakouts";

type PlaceItem = {
  id: PlaceId;
  href: string;
  label: string;
  /** Second line in the expanded rail (the Figma design's place subtitle). */
  sub: string;
  hint: string;
  icon: typeof Upload;
  count?: number;
  /** False while an earlier step is unfinished. The place still opens; it just can't do much yet. */
  ready: boolean;
};

type SecondaryId = "needs" | "residuals" | "roadmap";

type SecondaryItem = {
  id: SecondaryId;
  href: string;
  label: string;
  icon: typeof Upload;
};

/**
 * Not in any nav list (demoted to inline tool links, or owner tools that moved
 * to /admin), but still valid `active` ids.
 */
const TOOL_LABELS: Partial<Record<ShellId, string>> = {
  matrix: "Matrix",
  ideation: "Ideation",
  presentation: "Presentation",
};

const SECONDARY: SecondaryItem[] = [
  { id: "needs", href: "/needs", label: "Needs", icon: ListChecks },
  { id: "residuals", href: "/residuals", label: "Residuals", icon: ClipboardList },
  { id: "roadmap", href: "/roadmap", label: "Roadmap", icon: ChartGantt },
];

/**
 * The four places of the owner's Figma design (KAN-8), in plan order. With AI
 * on, Upload comes first; with AI off nothing is uploaded or parsed, so the
 * flow starts on Evidence Inventory (add gaps and tactics by hand there).
 */
function placesOf(nav: PlanNavModel, ai: boolean): PlaceItem[] {
  const gapsUnlocked = nav.gapsUnlocked || !ai;
  // Owner feedback (KAN-52): Room is out for now, so its context, mapping table and
  // breakouts live here in Prep, in plan order.
  const context: PlaceItem = {
    id: "setup",
    href: "/setup",
    label: "Plan context",
    sub: "Asset, objectives & people",
    hint: "The asset, objectives, decisions, landscape and people behind this plan",
    icon: Rocket,
    ready: true,
  };
  const places: PlaceItem[] = [
    {
      id: "gaps",
      href: "/?place=gaps",
      label: "Evidence Inventory",
      sub: "Gaps & metadata",
      hint: gapsUnlocked ? "Every gap with its tactics and computed status" : "Waiting on Upload: ingest a source or add a gap by hand",
      icon: ClipboardList,
      count: nav.unvalidatedCount || nav.gapsCount,
      ready: gapsUnlocked,
    },
    {
      id: "plan",
      href: "/?place=plan",
      label: "Prioritization Matrix",
      sub: "Priority canvas",
      hint: nav.planUnlocked ? "Place Open gaps and validate their priority" : "Waiting on Evidence Inventory: validate every gap first",
      icon: Columns3,
      ready: nav.planUnlocked,
    },
    {
      id: "mappings",
      href: "/mappings",
      label: "Mapping table",
      sub: "Gap ↔ tactic",
      hint: "One row per gap with its tactics and mapping status",
      icon: Columns3,
      ready: gapsUnlocked,
    },
    {
      id: "tactics",
      href: "/?place=tactics",
      label: "Tactic Ideation",
      sub: "Gap tactics",
      hint: nav.tacticsUnlocked ? "Ideate and assign tactics for High-priority gaps" : "Waiting on the Prioritization Matrix: validate every Open gap's priority first",
      icon: ListChecks,
      ready: nav.tacticsUnlocked,
    },
    {
      id: "timeline",
      href: "/timeline",
      label: "Gantt Timeline",
      sub: "Schedule view",
      hint: "The living IEGP as an interactive Gantt",
      icon: ChartGantt,
      ready: true,
    },
    {
      id: "breakouts",
      href: "/breakouts",
      label: "Breakout groups",
      sub: "Workshop groups & gaps",
      hint: "Group gaps by theme and assign them for the workshop",
      icon: Users,
      ready: true,
    },
  ];
  return ai
    ? [
        context,
        {
          id: "upload",
          href: "/?place=upload",
          label: "Upload",
          sub: "Sources & parsing",
          hint: "Upload sources, or add gaps and tactics by hand",
          icon: Upload,
          ready: true,
        },
        ...places,
      ]
    : [context, ...places];
}

function itemActive(active: ShellId, id: PlaceItem["id"] | SecondaryItem["id"]) {
  return active === id;
}

function NavButton({
  item,
  active,
  dense,
}: {
  item: PlaceItem | SecondaryItem;
  active: ShellId;
  dense?: boolean;
}) {
  const Icon = item.icon;
  const isActive = itemActive(active, item.id);
  const ready = "ready" in item ? item.ready : true;
  const count = "count" in item ? item.count : undefined;
  const sub = "sub" in item ? item.sub : null;
  // In the rail (`dense`) labels are hidden until the rail opens on hover or focus.
  const reveal = dense ? "opacity-0 transition-opacity group-data-[open=true]/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100" : "";
  const className = cn(
    "relative flex w-full items-center gap-2.5 rounded-md border px-2.5 text-left no-underline transition-colors",
    sub ? "min-h-10 py-1.5" : "h-8",
    isActive
      ? "border-sidebar-ring/60 bg-sidebar-accent text-sidebar-accent-foreground"
      : "border-transparent text-sidebar-foreground/75 hover:bg-muted hover:text-sidebar-foreground",
    !ready && !isActive && "text-sidebar-foreground/55",
  );
  const body = (
    <>
      {isActive && dense ? (
        <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-sidebar-primary group-data-[open=true]/rail:hidden group-has-[:focus-visible]/rail:hidden" />
      ) : null}
      <Icon className={cn("size-4 shrink-0", isActive ? "text-sidebar-primary" : "text-muted-foreground")} aria-hidden />
      <span className={cn("grid min-w-0 flex-1", reveal)}>
        <span className={cn("truncate text-[11.5px] tracking-tight", isActive && "font-semibold")}>{item.label}</span>
        {sub ? <span className="truncate text-[10px] text-muted-foreground">{sub}</span> : null}
      </span>
      {typeof count === "number" && count > 0 ? (
        <span className={cn("text-[10px] text-muted-foreground", reveal)}>{count}</span>
      ) : null}
      {!ready ? (
        <>
          <Hourglass
            className={cn("size-3 shrink-0 text-[var(--unknown-foreground)]", reveal)}
            aria-hidden
            data-testid={`nav-waiting-${item.id}`}
          />
          <span className="sr-only">(waiting on an earlier step)</span>
        </>
      ) : null}
    </>
  );

  return (
    <Link href={item.href} className={className} title={"hint" in item ? item.hint : item.label}>
      {body}
    </Link>
  );
}

/**
 * Prep (plan the IEGP) or Room (facilitate the workshop). Both sides render it,
 * so whichever mode you are in, the other is one click away.
 */
export function PrepRoomToggle({ mode = "prep", dense }: { mode?: "prep" | "room"; dense?: boolean }) {
  const current = "flex h-6 items-center justify-center rounded bg-sidebar-accent text-sidebar-accent-foreground";
  const other =
    "flex h-6 items-center justify-center rounded text-sidebar-foreground/70 no-underline hover:bg-sidebar-accent/70 hover:text-sidebar-foreground";
  return (
    <div
      className={cn("grid grid-cols-2 gap-0.5 rounded-md bg-sidebar-accent/40 p-0.5 text-[11px]", dense ? "mb-3" : "mb-3")}
      role="group"
      aria-label="Prep or Room mode"
    >
      {mode === "prep" ? (
        <span className={current} aria-current="true">
          Prep
        </span>
      ) : (
        <Link href="/" className={other} title="Back to preparing the plan">
          Prep
        </Link>
      )}
      {mode === "room" ? (
        <span className={current} aria-current="true">
          Room
        </span>
      ) : (
        <Link href="/room" className={other} title="Facilitate in the room — the workshop surface">
          Room
        </Link>
      )}
    </div>
  );
}

function NavLists({
  nav,
  active,
  dense,
  label,
}: {
  nav: PlanNavModel;
  active: ShellId;
  dense?: boolean;
  label: string;
}) {
  const places = placesOf(nav, useAiEnabled("ingestion"));
  const reveal = dense ? "opacity-0 transition-opacity group-data-[open=true]/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100" : "";
  // Rail-only extras take no room until the rail opens.
  const openOnly = dense ? "hidden group-data-[open=true]/rail:block group-has-[:focus-visible]/rail:block" : "";
  return (
    <>
      <p className={cn("px-2 pb-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70", openOnly)}>
        Workspace
      </p>
      <nav aria-label={label} className="grid gap-0.5">
        {places.map((item) => (
          <NavButton key={item.id} item={item} active={active} dense={dense} />
        ))}
      </nav>
      <details className={cn("mt-auto border-t border-sidebar-border pt-3", reveal)} aria-label={dense ? "More" : "More places"}>
        <summary
          className={cn(
            "cursor-pointer list-none text-[11px] text-sidebar-foreground/60 marker:content-none",
            dense ? "text-center md:text-left" : "",
          )}
        >
          <span className={dense ? "hidden md:inline" : undefined}>More</span>
          <span className={dense ? "md:hidden" : "hidden"}>···</span>
        </summary>
        <div className="mt-1 grid gap-0.5" role="navigation" aria-label={dense ? "More places" : "All more places"}>
          {SECONDARY.map((item) => (
            <NavButton key={item.id} item={item} active={active} dense={dense} />
          ))}
          <RestartWalkthroughButton variant="link" className="h-8 px-2 text-sidebar-foreground/70" />
        </div>
      </details>
      <ThemeToggle className="mt-1" labelClassName={reveal} />
    </>
  );
}

export function PlanChrome({
  children,
  active,
  nav,
  workspace,
  present = false,
}: {
  children: React.ReactNode;
  active: ShellId;
  nav: PlanNavModel;
  /** The open workspace and the switcher's list; omitted only when the store is unavailable. */
  workspace?: WorkspaceTagModel | null;
  /** Room presenting this page (`?present=1`): just the content, no sidebar, header or strip. */
  present?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  // Upload is a place only while the admin has ingestion on (KAN-53).
  const ai = useAiEnabled("ingestion");
  const places = placesOf(nav, ai);
  const current =
    places.find((p) => p.id === active)?.label ??
    SECONDARY.find((s) => s.id === active)?.label ??
    TOOL_LABELS[active] ??
    "Synapse IEGP";
  // With AI off Gaps is always open, so the strip waits for the first gap.
  const showReadiness = nav.gapsCount > 0 || (ai && nav.gapsUnlocked);

  return (
    <div className="flex min-h-full bg-background">
      {present ? null : (
      // The rail keeps its 52px slot in the layout; the panel widens over the
      // page on hover or keyboard focus, so the content never shifts.
      <div data-app-chrome className="relative hidden w-[52px] shrink-0 md:block">
        {/* Opens while the pointer moves over it, or for keyboard focus. Not focus-within: a mouse
            click leaves focus on the link and would keep the rail open over the page. */}
        <aside
          aria-label="Synapse navigation"
          data-open={railOpen}
          onPointerMove={(event) => {
            // A pointer that moves over the rail opens it. CSS :hover would also open it for a
            // resting pointer (a headless browser's starts at 0,0), which fires no pointermove,
            // and leave it open over the page, swallowing clicks up to 220px from the left.
            if (event.pointerType === "mouse" && !railOpen) setRailOpen(true);
          }}
          onPointerLeave={() => setRailOpen(false)}
          className="group/rail sticky top-0 z-30 flex h-dvh w-[52px] flex-col overflow-hidden border-r border-sidebar-border bg-sidebar transition-[width,box-shadow] duration-200 ease-out data-[open=true]:w-[220px] data-[open=true]:shadow-xl has-[:focus-visible]:w-[220px] has-[:focus-visible]:shadow-xl"
        >
          <Link
            href="/"
            className="flex h-10 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-[15px] no-underline"
            aria-label="Synapse IEGP"
          >
            <BrandMark />
            <span className="grid leading-tight opacity-0 transition-opacity group-data-[open=true]/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100">
              <span className="text-[12px] font-bold tracking-tight text-foreground">Synapse</span>
              <span className="text-[9.5px] text-muted-foreground">IEGP Workspace</span>
            </span>
          </Link>
          {workspace ? (
            <div className="shrink-0 border-b border-sidebar-border px-[9px] py-2">
              <WorkspaceTag tag={workspace} dense />
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-[6px] py-2">
            <NavLists nav={nav} active={active} dense label="Places" />
          </div>
        </aside>
      </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {present ? null : (
        <header data-app-chrome className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-2 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label="Open places" />
              }
            >
              <Menu className="size-4" />
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-3">
              <SheetHeader className="px-1 pb-2">
                <SheetTitle className="text-[13px]">Synapse IEGP</SheetTitle>
              </SheetHeader>
              <div className="flex h-[calc(100%-3rem)] flex-col" onClick={() => setOpen(false)}>
                <NavLists nav={nav} active={active} label="All places" />
              </div>
            </SheetContent>
          </Sheet>
          <p className="text-[13px] font-medium text-foreground">{current}</p>
        </header>
        )}
        {showReadiness && !present ? <ReadinessStrip nav={nav} /> : null}
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * Always-visible strip so the facilitator can answer "can we start the workshop?"
 * in a glance. Partial/Unconfirmed link straight into Gaps with the matching
 * filter chip selected. See docs/consultant-ux-spec.md §5.
 */
function ReadinessStrip({ nav }: { nav: PlanNavModel }) {
  const blocked = nav.partialCount > 0 || nav.unvalidatedCount > 0;
  return (
    <div
      data-app-chrome
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-1.5 text-[11px] sm:px-6",
        blocked ? "bg-amber-500/10 text-amber-700 dark:text-amber-200" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
      )}
      role="status"
      aria-label="Prep readiness"
    >
      <Link href="/?place=gaps" className="text-inherit no-underline hover:underline">
        Gaps {nav.gapsCount}
      </Link>
      <Link href="/?place=gaps&gap_filter=partial" className="text-inherit no-underline hover:underline">
        Partial {nav.partialCount}
      </Link>
      <Link
        href="/?place=gaps&gap_filter=needs_validation"
        className="text-inherit no-underline hover:underline"
      >
        Unconfirmed {nav.unvalidatedCount}
      </Link>
      <span className="font-medium">
        {readinessText(nav)}
      </span>
    </div>
  );
}
