"use client";

/** Shared confirmed-state and save feedback for the platform AI switches. */
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/post-json";

type SaveState = {
  serverEnabled: boolean;
  enabled: boolean;
  pending: boolean;
  status: string;
  error: string;
};

/** Save one switch, retaining the last confirmed state until persistence succeeds. */
export function useAiSwitchSave({
  enabled,
  scope,
  body,
  readEnabled,
  disabled = false,
}: {
  enabled: boolean;
  scope: string;
  body: Record<string, unknown>;
  readEnabled: (json: unknown) => unknown;
  disabled?: boolean;
}) {
  const router = useRouter();
  const feedbackId = useId();
  // A ref closes the gap before React renders disabled after a synchronous click.
  const saving = useRef(false);
  const [state, setState] = useState<SaveState>({ serverEnabled: enabled, enabled, pending: false, status: "", error: "" });
  if (enabled !== state.serverEnabled) {
    setState({ ...state, serverEnabled: enabled, enabled, status: state.pending || state.enabled === enabled ? state.status : "", error: "" });
  }

  async function flip() {
    if (saving.current || disabled) return;
    saving.current = true;
    const requested = !state.enabled;
    setState(current => ({ ...current, pending: true, status: `Saving AI for ${scope}…`, error: "" }));
    try {
      const result = await postJson("/api/control", { ...body, enabled: requested });
      const saved = result.ok ? readEnabled(result.json) : undefined;
      if (typeof saved !== "boolean") throw new Error("Unconfirmed switch response");
      setState(current => ({ ...current, enabled: saved, pending: false, status: `AI for ${scope} is ${saved ? "on" : "off"}. Saved.`, error: "" }));
      // Only the server panel supplies the persisted actor and time.
      router.refresh();
    } catch {
      setState(current => ({ ...current, pending: false, status: "", error: `Could not turn ${requested ? "on" : "off"} AI for ${scope}. Try again.` }));
    } finally {
      saving.current = false;
    }
  }

  return { ...state, feedbackId, flip };
}
