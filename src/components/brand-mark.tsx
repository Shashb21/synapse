import { cn } from "@/lib/utils";

/** The Synapse logo mark from the design (KAN-8): an indigo-to-violet tile with an S. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[22px] shrink-0 items-center justify-center rounded-[5px] bg-gradient-to-br from-indigo-600 to-violet-600 text-[10px] font-bold text-white shadow-sm",
        className,
      )}
    >
      S
    </span>
  );
}

/** Mark plus wordmark, for headers outside a workspace (workspaces, account, login, admin). */
export function BrandLockup({ subtitle = "IEGP Workspace" }: { subtitle?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark />
      <span className="grid leading-tight">
        <span className="text-[12px] font-bold tracking-tight text-foreground">Synapse</span>
        <span className="text-[9.5px] text-muted-foreground">{subtitle}</span>
      </span>
    </span>
  );
}
