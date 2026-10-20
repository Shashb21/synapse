"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { installTacticDraftNavigation } from "@/lib/tactic-draft-navigation";

export type TacticDraftGuard = { allowDiscard: () => boolean; reset: () => void };

/** One draft owner for both full-record navigation and panel closing. */
export function useTacticDraftGuard() {
  const state = useRef({ dirty: false, pending: false });
  const [blocked, setBlocked] = useState(false);
  const setDirty = useCallback((dirty: boolean) => {
    state.current.dirty = dirty;
    setBlocked(dirty || state.current.pending);
  }, []);
  const setPending = useCallback((pending: boolean) => {
    state.current.pending = pending;
    setBlocked(pending || state.current.dirty);
  }, []);
  const reset = useCallback(() => {
    state.current = { dirty: false, pending: false };
    setBlocked(false);
  }, []);
  const allowDiscard = useCallback(() => !state.current.pending && (!state.current.dirty || window.confirm("Discard unsaved changes?")), []);

  useEffect(() => {
    if (!blocked) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!state.current.dirty && !state.current.pending) return;
      event.preventDefault();
      event.returnValue = "Unsaved tactic changes";
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
      const destination = new URL(anchor.href, location.href);
      // Native document navigation uses beforeunload. New tabs and in-record
      // fragment navigation leave this editor mounted and need no confirmation.
      if (destination.origin !== location.origin || (destination.pathname === location.pathname && destination.search === location.search)) return;
      if (!allowDiscard()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const unprotect = installTacticDraftNavigation().protect(allowDiscard);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, { capture: true });
    return () => {
      unprotect();
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, { capture: true });
    };
  }, [blocked, allowDiscard]);

  return { setDirty, setPending, reset, allowDiscard };
}
