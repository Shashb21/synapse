"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Columns3,
  FileText,
  FlaskConical,
  Inbox,
  ListChecks,
  Lock,
  Menu,
  Sparkles,
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
import type { PlanPlace } from "@/lib/iegp/engine";

export type ShellId =
  | PlanPlace
  | "needs"
  | "gaps"
  | "tactics"
  | "residuals"
  | "roadmap"
  | "sources"
  | "evals"
  | "sdlc"
  | "extract-runs";

export type PlanNavModel = {
  gapsCount: number;
  unvalidatedCount: number;
  gapsUnlocked: boolean;
  planUnlocked: boolean;
  tacticsUnlocked: boolean;
};

type PlaceItem = {
  id: PlanPlace;
  href: string;
  label: string;
  hint: string;
  icon: typeof Upload;
  count?: number;
  unlocked: boolean;
};

type SecondaryItem = {
  id: "evals" | "sdlc" | "extract-runs";
  href: string;
  label: string;
  icon: typeof FlaskConical;
};

const SECONDARY: SecondaryItem[] = [
  { id: "extract-runs", href: "/extract-runs", label: "Extract", icon: Sparkles },
  { id: "evals", href: "/evals", label: "Eval", icon: FlaskConical },
  { id: "sdlc", href: "/sdlc", label: "Spec", icon: FileText },
];

function placesOf(nav: PlanNavModel): PlaceItem[] {
  return [
    {
      id: "upload",
      href: "/?place=upload",
      label: "Upload",
      hint: "Demo pack and ingest",
      icon: Upload,
      unlocked: true,
    },
    {
      id: "gaps",
      href: "/?place=gaps",
      label: "Gaps",
      hint: nav.gapsUnlocked ? "Mapped gaps with computed status" : "Ingest a source first",
      icon: Inbox,
      count: nav.unvalidatedCount || nav.gapsCount,
      unlocked: nav.gapsUnlocked,
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
  const places = placesOf(nav);
  return (
    <>
      <nav aria-label={label} className="grid gap-0.5">
        {places.map((item) => (
          <NavButton key={item.id} item={item} active={active} dense={dense} />
        ))}
      </nav>
      <div className="mt-auto grid gap-0.5 border-t border-sidebar-border pt-3" role="navigation" aria-label={dense ? "Tapes" : "All tapes"}>
        {SECONDARY.map((item) => (
          <NavButton key={item.id} item={item} active={active} dense={dense} />
        ))}
      </div>
    </>
  );
}

export function PlanChrome({
  children,
  active,
  nav,
}: {
  children: React.ReactNode;
  active: ShellId;
  nav: PlanNavModel;
}) {
  const [open, setOpen] = useState(false);
  const places = placesOf(nav);
  const current =
    places.find((p) => p.id === active)?.label ??
    SECONDARY.find((s) => s.id === active)?.label ??
    "Synapse IEGP";

  return (
    <div className="flex min-h-full bg-background">
      <aside className="sticky top-0 z-20 flex h-dvh w-12 shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-3 md:w-60 md:px-2">
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
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 px-1 md:px-0">
          <NavLists nav={nav} active={active} dense label="Places" />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-2 md:hidden">
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
        <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
