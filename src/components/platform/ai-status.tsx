"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

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
  /** Which switch turned AI off, when it is off. */
  offBy: AiOffBy;
  setLocal: (next: { enabled: boolean; offBy: AiOffBy }) => void;
};

const AiStatusContext = createContext<AiStatus>({ enabled: true, offBy: null, setLocal: () => undefined });

export function AiStatusProvider({
  enabled,
  offBy,
  children,
}: {
  enabled: boolean;
  offBy?: AiOffBy;
  children?: ReactNode;
}) {
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
    () => ({ enabled: current.enabled, offBy: current.offBy, setLocal }),
    [current.enabled, current.offBy, setLocal],
  );
  return <AiStatusContext.Provider value={value}>{children}</AiStatusContext.Provider>;
}

export function useAiEnabled(): boolean {
  return useContext(AiStatusContext).enabled;
}

/** Why AI is off: "platform" (the Synapse administrator) or "workspace" (its owner); null while on. */
export function useAiOffBy(): AiOffBy {
  return useContext(AiStatusContext).offBy;
}

/** Sets the status on the client at once, ahead of the server refresh. */
export function useSetAiEnabled(): AiStatus["setLocal"] {
  return useContext(AiStatusContext).setLocal;
}

/** Renders its children only while AI is on. */
export function AiOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return useAiEnabled() ? <>{children}</> : <>{fallback}</>;
}

/** Renders its children only while AI is off. */
export function AiOffOnly({ children }: { children: ReactNode }) {
  return useAiEnabled() ? null : <>{children}</>;
}

/** The strip across every page while AI is off, saying who turned it off. */
export function AiOffBanner() {
  const { enabled, offBy } = useContext(AiStatusContext);
  if (enabled) return null;
  return (
    <p
      role="status"
      data-testid="ai-off-banner"
      className="border-b border-border bg-card/60 px-4 py-1.5 text-center text-[12px] text-muted-foreground"
    >
      {offBy === "workspace"
        ? "AI assistance is off for this workspace. Everything is entered and edited by hand; no suggestions or automatic AI steps run."
        : "AI is off. Everything is entered and edited by hand; no suggestions or automatic AI steps run."}
    </p>
  );
}
