"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether an admin has AI switched on. Read once per request in the root
 * layout; client components use it to hide AI controls and show the manual
 * path instead. The server still refuses AI work on its own when AI is off.
 */
const AiStatusContext = createContext(true);

export function AiStatusProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <AiStatusContext.Provider value={enabled}>{children}</AiStatusContext.Provider>;
}

export function useAiEnabled(): boolean {
  return useContext(AiStatusContext);
}

/** Renders its children only while AI is on. */
export function AiOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return useAiEnabled() ? <>{children}</> : <>{fallback}</>;
}

/** Renders its children only while AI is off. */
export function AiOffOnly({ children }: { children: ReactNode }) {
  return useAiEnabled() ? null : <>{children}</>;
}
