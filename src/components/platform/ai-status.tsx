"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AI_SECTION_IDS, noAiSections, type AiSectionId, type AiSections } from "@/modules/kernel/ai-sections";

/**
 * Whether AI is on for the open workspace: the platform master switch AND the
 * workspace's own AI assistance setting. Read once per request in the root
 * layout; client components use it to hide AI controls and show the manual
 * path instead. The server still refuses AI work on its own when AI is off.
 *
 * The workspace AI switch sets it straight away (`useSetAiEnabled`), before
 * `router.refresh()` brings the server's value, so the flow changes at once.
 */
export type AiOffBy = "platform" | "workspace" | null;

type AiStatus = {
  enabled: boolean;
  /** Per section (KAN-53): the admin's master switch AND the section's switch. */
  sections: AiSections;
  /** Which switch turned AI off, when it is off. */
  offBy: AiOffBy;
  setLocal: (next: { enabled: boolean; offBy: AiOffBy }) => void;
};

const AiStatusContext = createContext<AiStatus>({
  enabled: false,
  sections: noAiSections(),
  offBy: "platform",
  setLocal: () => undefined,
});

export function AiStatusProvider({
  enabled,
  offBy,
  sections,
  children,
}: {
  enabled: boolean;
  offBy?: AiOffBy;
  /** Left out (tests, older callers): every section follows `enabled`. */
  sections?: AiSections;
  children?: ReactNode;
}) {
  const bySection = useMemo(
    () =>
      sections ??
      (Object.fromEntries(AI_SECTION_IDS.map((id) => [id, enabled])) as AiSections),
    [sections, enabled],
  );
  const serverOffBy: AiOffBy = enabled ? null : (offBy ?? "platform");
  // A local value set by the switch, dropped as soon as the server sends a new one.
  const [local, setLocalState] = useState<{ enabled: boolean; offBy: AiOffBy; from: string } | null>(null);
  const serverKey = `${enabled}:${serverOffBy}`;
  const current = local && local.from === serverKey ? local : { enabled, offBy: serverOffBy };
  const setLocal = useCallback(
    (next: { enabled: boolean; offBy: AiOffBy }) => setLocalState({ ...next, from: serverKey }),
    [serverKey],
  );
  const value = useMemo(
    () => ({
      enabled: current.enabled,
      // A local "off" (set ahead of the refresh) turns every section off at once.
      sections: current.enabled ? bySection : noAiSections(),
      offBy: current.offBy,
      setLocal,
    }),
    [current.enabled, current.offBy, setLocal, bySection],
  );
  return <AiStatusContext.Provider value={value}>{children}</AiStatusContext.Provider>;
}

/**
 * Whether AI is on. Give a section to ask about that section only (KAN-53); with none, it
 * says whether any AI runs at all.
 */
export function useAiEnabled(section?: AiSectionId): boolean {
  const status = useContext(AiStatusContext);
  return section ? status.sections[section] : status.enabled;
}

/** Why AI is off: "platform" (the Synapse administrator) or "workspace" (its owner); null while on. */
export function useAiOffBy(): AiOffBy {
  return useContext(AiStatusContext).offBy;
}

/** Sets the status on the client at once, ahead of the server refresh. */
export function useSetAiEnabled(): AiStatus["setLocal"] {
  return useContext(AiStatusContext).setLocal;
}

/** Renders its children only while AI (or the given section) is on. */
export function AiOnly({
  children,
  fallback = null,
  section,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  section?: AiSectionId;
}) {
  return useAiEnabled(section) ? <>{children}</> : <>{fallback}</>;
}

/** Renders its children only while AI (or the given section) is off. */
export function AiOffOnly({ children, section }: { children: ReactNode; section?: AiSectionId }) {
  return useAiEnabled(section) ? null : <>{children}</>;
}

/** Formerly the strip across every page while AI was off. */
export function AiOffBanner() {
  // Owner decision (KAN-53): with AI off a customer sees the manual flow and is not told
  // about AI, so there is no banner. Kept as a component so the layout slot stays.
  return null;
}
