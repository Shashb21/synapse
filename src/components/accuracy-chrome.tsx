"use client";

import Link from "next/link";
import { PrepRoomToggle } from "@/components/plan-chrome";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  Activity,
  BookMarked,
  Building2,
  ChartGantt,
  FileStack,
  Flag,
  GitCompareArrows,
  Menu,
  Presentation,
  ScrollText,
  SlidersHorizontal,
  Target,
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
import {
  chromePlanLabelStatus,
  chromeStackCaption,
  normalizePlanLabel,
  type PlanLabel,
} from "@/accuracy/domain/plan-label";

export type AccuracyShellId =
  | "workspaces"
  | "sources"
  | "review"
  | "ledger"
  | "coverage"
  | "workshop"
  | "plan"
  | "timeline"
  | "audit"
  | "control"
  | "runs";

type NavItem = {
  id: AccuracyShellId;
  href: string;
  label: string;
  icon: typeof Building2;
};

const NAV: NavItem[] = [
  { id: "workspaces", href: "/accuracy", label: "Workspaces", icon: Building2 },
  { id: "sources", href: "/accuracy/sources", label: "Sources", icon: FileStack },
  { id: "review", href: "/accuracy/review", label: "Review", icon: Flag },
  { id: "ledger", href: "/accuracy/ledger", label: "Ledger", icon: BookMarked },
  { id: "coverage", href: "/accuracy/coverage", label: "Coverage", icon: GitCompareArrows },
  { id: "workshop", href: "/accuracy/workshop", label: "Workshop", icon: Presentation },
  { id: "plan", href: "/accuracy/plan", label: "Plan", icon: Target },
  { id: "timeline", href: "/accuracy/timeline", label: "Timeline", icon: ChartGantt },
  { id: "audit", href: "/accuracy/audit", label: "Audit", icon: ScrollText },
  { id: "control", href: "/accuracy/control", label: "Routing", icon: SlidersHorizontal },
  { id: "runs", href: "/accuracy/runs", label: "Runs", icon: Activity },
];

function withWorkspace(href: string, workspaceId: string | null): string {
  if (!workspaceId || href === "/accuracy") return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}workspace_id=${encodeURIComponent(workspaceId)}`;
}

function NavButton({
  item,
  active,
  dense,
  workspaceId,
  onNavigate,
}: {
  item: NavItem;
  active: AccuracyShellId;
  dense?: boolean;
  workspaceId: string | null;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const isActive = active === item.id;
  const href = withWorkspace(item.href, workspaceId);
  const className = cn(
    "flex w-full items-center gap-2 rounded-md px-2 text-left no-underline transition-colors",
    dense ? "h-9 justify-center md:justify-start md:h-8" : "h-8",
    isActive
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
  );
  return (
    <Link href={href} className={className} onClick={onNavigate}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", dense && "hidden md:inline")}>
        {item.label}
      </span>
    </Link>
  );
}

function AccuracyChromeInner({
  children,
  active,
  planLabel: planLabelProp = null,
}: {
  children: React.ReactNode;
  active: AccuracyShellId;
  planLabel?: PlanLabel | null;
}) {
  const [open, setOpen] = useState(false);
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get("workspace_id");
  const current = NAV.find((item) => item.id === active)?.label ?? "Accuracy";
  // The fetched label remembers which workspace it belongs to, so a stale one is never shown.
  const [fetched, setFetched] = useState<{ workspace_id: string; label: PlanLabel | null } | null>(null);
  const fetchedLabel = fetched && fetched.workspace_id === workspaceId ? fetched.label : null;
  const planLabel = planLabelProp ?? fetchedLabel;
  const planStatus = chromePlanLabelStatus(planLabel);

  useEffect(() => {
    if (planLabelProp || !workspaceId) return;
    let cancelled = false;
    fetch(`/api/accuracy/workspaces?workspace_id=${encodeURIComponent(workspaceId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { workspace?: { plan_label?: unknown } } | null) => {
        if (cancelled) return;
        setFetched({ workspace_id: workspaceId, label: normalizePlanLabel(body?.workspace?.plan_label) });
      })
      .catch(() => {
        if (!cancelled) setFetched({ workspace_id: workspaceId, label: null });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, planLabelProp]);

  return (
    <div className="flex min-h-full bg-background">
      <aside className="sticky top-0 z-20 flex h-dvh w-12 shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-3 md:w-60 md:px-2">
        <Link
          href="/accuracy"
          className="mb-1 hidden px-2 text-[13px] font-medium text-sidebar-foreground no-underline md:block"
        >
          Synapse · Accuracy
        </Link>
        {planStatus ? (
          <p
            className="mb-1 hidden px-2 text-[11px] font-medium text-sidebar-foreground md:block"
            role="status"
            aria-label={planStatus}
            data-plan-label={planLabel}
          >
            {planLabel}
          </p>
        ) : null}
        <p className="mb-4 hidden px-2 text-[11px] text-muted-foreground md:block">
          {chromeStackCaption(planLabel)}
        </p>
        <Link
          href="/accuracy"
          className="mb-3 flex items-center justify-center text-[11px] font-medium text-sidebar-foreground no-underline md:hidden"
          aria-label="Accuracy"
        >
          A
        </Link>
        <div className="px-1 md:px-0">
          <PrepRoomToggle mode="room" dense />
        </div>
        <nav aria-label="Accuracy" className="flex min-h-0 flex-1 flex-col gap-0.5 px-1 md:px-0">
          {NAV.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={active}
              dense
              workspaceId={workspaceId}
            />
          ))}
          <div className="mt-auto border-t border-sidebar-border pt-3">
            <Link
              href="/control"
              className="flex h-8 items-center gap-2 rounded-md px-2 text-[12px] text-sidebar-foreground/70 no-underline hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
            >
              <span className="hidden md:inline">Legacy control panel</span>
              <span className="md:hidden">Legacy</span>
            </Link>
          </div>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-2 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Open accuracy navigation" />}
            >
              <Menu className="size-4" />
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-3">
              <SheetHeader className="px-1 pb-2">
                <SheetTitle className="text-[13px]">Synapse · Accuracy</SheetTitle>
              </SheetHeader>
              <div className="grid gap-0.5" onClick={() => setOpen(false)}>
                {NAV.map((item) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    active={active}
                    workspaceId={workspaceId}
                    onNavigate={() => setOpen(false)}
                  />
                ))}
              </div>
            </SheetContent>
          </Sheet>
          <p className="text-[13px] font-medium text-foreground">{current}</p>
          {planStatus ? (
            <span
              className="ml-auto text-[11px] text-muted-foreground"
              role="status"
              aria-label={planStatus}
              data-plan-label={planLabel}
            >
              {planLabel}
            </span>
          ) : null}
        </header>
        <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

export function AccuracyChrome({
  children,
  active,
  planLabel = null,
}: {
  children: React.ReactNode;
  active: AccuracyShellId;
  planLabel?: PlanLabel | null;
}) {
  return (
    <Suspense fallback={<div className="min-h-full bg-background p-4 text-[12px] text-muted-foreground">Loading…</div>}>
      <AccuracyChromeInner active={active} planLabel={planLabel}>
        {children}
      </AccuracyChromeInner>
    </Suspense>
  );
}
