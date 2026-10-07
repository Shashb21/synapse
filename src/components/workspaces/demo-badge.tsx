import { Badge } from "@/components/ui/badge";

/** Marks a workspace that holds the Velmara demo data rather than a team's own plan. */
export function DemoBadge({ testId = "demo-badge" }: { testId?: string }) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title="This workspace holds demo data (Velmara)"
      className="h-4 border-amber-500/60 px-1.5 text-[10px] font-medium normal-case tracking-normal text-amber-600 dark:text-amber-300"
    >
      Demo
    </Badge>
  );
}
