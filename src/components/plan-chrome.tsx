"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ChartGantt,
  ClipboardList,
  Columns3,
  ListChecks,
  Lock,
  Menu,
  PencilLine,
  Rocket,
  Upload,
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
};

type PlaceId = PlanPlace | "timeline";

type PlaceItem = {
  id: PlaceId;
  href: string;
  label: string;
  hint: string;
  icon: typeof Upload;
  count?: number;
  unlocked: boolean;
};

type SecondaryId = "needs" | "residuals" | "roadmap" | "mappings" | "setup";

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
  breakouts: "Breakout groups",
  presentation: "Presentation",
};

const SECONDARY: SecondaryItem[] = [
  { id: "setup", href: "/setup", label: "Get started", icon: Rocket },
  { id: "needs", href: "/needs", label: "Needs", icon: ListChecks },
  { id: "residuals", href: "/residuals", label: "Residuals", icon: ClipboardList },
  { id: "roadmap", href: "/roadmap", label: "Roadmap", icon: ChartGantt },
  { id: "mappings", href: "/mappings", label: "Mapping table", icon: Columns3 },
];

/**
 * With AI off nothing is uploaded or parsed: the first place is Start (add
 * gaps and tactics by hand) and Gaps never waits for an ingested source.
 */
function placesOf(nav: PlanNavModel, ai: boolean): PlaceItem[] {
  const gapsUnlocked = nav.gapsUnlocked || !ai;
  return [
    ai
      ? {
          id: "upload",
          href: "/?place=upload",
          label: "Upload",
          hint: "Demo pack and ingest",
          icon: Upload,
          unlocked: true,
        }
      : {
          id: "upload",
          href: "/?place=upload",
          label: "Start",
          hint: "Add gaps and tactics by hand",
          icon: PencilLine,
          unlocked: true,
        },
    {
      id: "gaps",
      href: "/?place=gaps",
      label: "Gaps",
      hint: gapsUnlocked ? "Mapped gaps with computed status" : "Ingest a source first",
      icon: ClipboardList,
      count: nav.unvalidatedCount || nav.gapsCount,
      unlocked: gapsUnlocked,
    },
    {
      id: "plan",
      href: "/?place=plan",
      label: "Prioritize",
      hint: nav.planUnlocked ? "Priority bands for open gaps" : "Validate every gap first",
      icon: Columns3,
      unlocked: nav.planUnlocked,
    },
    {
      id: "tactics",
      href: "/?place=tactics",
      label: "Tactics",
      hint: nav.tacticsUnlocked ? "Create and assign tactics for open gaps" : "Prioritize first",
      icon: ListChecks,
      unlocked: nav.tacticsUnlocked,
    },
    {
      id: "timeline",
      href: "/timeline",
      label: "Timeline",
      hint: "The living IEGP as an interactive Gantt",
      icon: ChartGantt,
      unlocked: true,
    },
  ];
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
  const unlocked = "unlocked" in item ? item.unlocked : true;
  const count = "count" in item ? item.count : undefined;
  const className = cn(
    "flex w-full items-center gap-2 rounded-md px-2 text-left no-underline transition-colors",
    dense ? "h-9 justify-center md:justify-start md:h-8" : "h-8",
    isActive
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
    !unlocked && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-sidebar-foreground/70",
  );
  const body = (
    <>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", dense && "hidden md:inline")}>
        {item.label}
      </span>
      {typeof count === "number" && count > 0 ? (
        <span
          className={cn(
            "text-[11px] text-muted-foreground",
            dense && "hidden md:inline",
          )}
        >
          {count}
        </span>
      ) : null}
      {!unlocked ? (
        <Lock className={cn("size-3 shrink-0 text-muted-foreground", dense && "hidden md:inline")} />
      ) : null}
    </>
  );

  if (!unlocked) {
    return (
      <span className={className} title={"hint" in item ? item.hint : item.label} aria-disabled>
        {body}
      </span>
    );
  }

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
  const places = placesOf(nav, useAiEnabled());
  return (
    <>
      <PrepRoomToggle dense={dense} />
      <nav aria-label={label} className="grid gap-0.5">
        {places.map((item) => (
          <NavButton key={item.id} item={item} active={active} dense={dense} />
        ))}
      </nav>
      <details className="mt-auto border-t border-sidebar-border pt-3" aria-label={dense ? "More" : "More places"}>
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
          <RestartWalkthroughButton
            variant="link"
            className={cn("h-8 px-2 text-sidebar-foreground/70", dense && "hidden md:inline-flex")}
          />
        </div>
      </details>
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
  const ai = useAiEnabled();
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
      <aside data-app-chrome className="sticky top-0 z-20 flex h-dvh w-12 shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-3 md:w-60 md:px-2">
        <Link
          href="/"
          className="mb-4 hidden px-2 text-[13px] font-medium text-sidebar-foreground no-underline md:block"
        >
          Synapse IEGP
        </Link>
        <Link
          href="/"
          className="mb-3 flex items-center justify-center text-[11px] font-medium text-sidebar-foreground no-underline md:hidden"
          aria-label="Synapse IEGP"
        >
          S
        </Link>
        {workspace ? (
          <div className="mb-3 px-1 md:px-0">
            <WorkspaceTag tag={workspace} dense />
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 px-1 md:px-0">
          <NavLists nav={nav} active={active} dense label="Places" />
        </div>
      </aside>
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
        <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-5 sm:px-6">{children}</main>
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
        blocked ? "bg-amber-500/10 text-amber-200" : "bg-emerald-500/10 text-emerald-200",
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
        {nav.readyForPrioritize ? "Ready for Prioritize" : "Not ready for Prioritize"}
      </span>
    </div>
  );
}
