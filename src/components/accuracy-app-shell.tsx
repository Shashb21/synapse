import { AccuracyChrome, type AccuracyShellId } from "@/components/accuracy-chrome";
import type { PlanLabel } from "@/accuracy/domain/plan-label";

/**
 * Shell for accuracy-first routes (/accuracy/*). Mirrors platform shell layout without
 * legacy IEGP place nav.
 */
export function AccuracyAppShell({
  children,
  active,
  planLabel = null,
}: {
  children: React.ReactNode;
  active: AccuracyShellId;
  planLabel?: PlanLabel | null;
}) {
  return (
    <AccuracyChrome active={active} planLabel={planLabel}>
      {children}
    </AccuracyChrome>
  );
}

export { PageIntro } from "@/components/app-shell";
