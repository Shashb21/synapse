import { AccuracyChrome, type AccuracyShellId } from "@/components/accuracy-chrome";

/**
 * Shell for accuracy-first routes (/accuracy/*). Mirrors platform shell layout without
 * legacy IEGP place nav.
 */
export function AccuracyAppShell({
  children,
  active,
}: {
  children: React.ReactNode;
  active: AccuracyShellId;
}) {
  return <AccuracyChrome active={active}>{children}</AccuracyChrome>;
}

export { PageIntro } from "@/components/app-shell";
