"use client";

import { useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";

/**
 * Re-reads the page's server data after a mutation (KAN-68). A bare
 * `router.refresh()` returns at once while the server re-renders, so a dialog
 * that closes first leaves the old list on screen for the seconds the refresh
 * takes, with nothing to say new data is coming. Here the refresh and whatever
 * `then` changes (closing a dialog, clearing a busy note) run in one
 * transition: they show together, with the new data, and `refreshing` stays
 * true until it has landed.
 *
 * `navigate` goes to another page the same way. A push fetches that page fresh,
 * and a refresh straight after a push would cancel the push, so it is one or
 * the other.
 */
export function usePageRefresh() {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const refresh = useCallback(
    (then?: () => void) => {
      startTransition(() => {
        then?.();
        router.refresh();
      });
    },
    [router],
  );
  const navigate = useCallback(
    (href: string, then?: () => void) => {
      startTransition(() => {
        then?.();
        router.push(href);
      });
    },
    [router],
  );
  return { refreshing, refresh, navigate };
}
