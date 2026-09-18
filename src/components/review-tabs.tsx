"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Component, type ReactNode, useTransition } from "react";
import { cn } from "@/lib/utils";

export type ReviewTab = "gaps" | "tactics";

function tabHref(tab: ReviewTab) {
  return `/?place=review&tab=${tab}`;
}

class TabErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <p role="alert" className="text-[12px] text-destructive">
          Could not load {this.props.label}. {this.state.error.message}
        </p>
      );
    }
    return this.props.children;
  }
}

export function ReviewInnerTabs({
  tab,
  gapCount,
  tacticCount,
  gaps,
  tactics,
}: {
  tab: ReviewTab;
  gapCount: number;
  tacticCount: number;
  gaps: ReactNode;
  tactics: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const loadingLabel = tab === "gaps" ? "Loading gaps…" : "Loading tactics…";

  function go(next: ReviewTab) {
    startTransition(() => {
      router.push(tabHref(next));
    });
  }

  return (
    <div className="grid gap-4">
      <div
        role="tablist"
        aria-label="Review"
        className="flex w-full flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1"
      >
        {(
          [
            { id: "gaps" as const, label: "Gaps", count: gapCount },
            { id: "tactics" as const, label: "Tactics", count: tacticCount },
          ] as const
        ).map((item) => {
          const selected = tab === item.id;
          return (
            <Link
              key={item.id}
              role="tab"
              href={tabHref(item.id)}
              aria-selected={selected}
              aria-controls={`review-panel-${item.id}`}
              id={`review-tab-${item.id}`}
              className={cn(
                "inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm no-underline transition-colors",
                selected
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={(event) => {
                event.preventDefault();
                go(item.id);
              }}
            >
              {item.label}
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {item.count}
              </span>
            </Link>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`review-panel-${tab}`}
        aria-labelledby={`review-tab-${tab}`}
        aria-busy={pending || undefined}
      >
        {pending ? (
          <p className="text-[12px] text-muted-foreground">{loadingLabel}</p>
        ) : tab === "gaps" ? (
          <TabErrorBoundary label="gaps">{gaps}</TabErrorBoundary>
        ) : (
          <TabErrorBoundary label="tactics">{tactics}</TabErrorBoundary>
        )}
      </div>
    </div>
  );
}

export function ReviewTabEmpty({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-muted-foreground">{children}</p>;
}
