import { Badge } from "@/components/ui/badge";

/** Marks a workspace that holds the Velmara demo data rather than a team's own plan. */
export function DemoBadge({ testId = "demo-badge" }: { testId?: string }) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title="This workspace holds demo data (Velmara)"
      className="h-4 border-unknown/40 px-1.5 text-caption font-medium normal-case tracking-normal text-unknown-foreground"
    >
      Demo
    </Badge>
  );
}
