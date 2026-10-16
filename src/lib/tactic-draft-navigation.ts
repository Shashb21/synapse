type CanLeave = () => boolean;
type DraftNavigation = { protect: (canLeave: CanLeave) => () => void };
/** Minimal platform surface: the installed TypeScript DOM library does not yet declare Navigation. */
type BrowserNavigation = EventTarget & {
  currentEntry: { key: string } | null;
  traverseTo: (key: string) => { committed: Promise<unknown>; finished: Promise<unknown> };
};
type DraftWindow = Window & { navigation?: BrowserNavigation; __synapseTacticDraftNavigation?: DraftNavigation };

/** Protect same-document traversal before the router can unmount a tactic draft. */
export function installTacticDraftNavigation(): DraftNavigation {
  const target = window as DraftWindow;
  if (target.__synapseTacticDraftNavigation) return target.__synapseTacticDraftNavigation;
  const browser = target.navigation;
  if (!browser?.currentEntry || typeof browser.traverseTo !== "function") {
    const navigation = installHistoryStateNavigation();
    target.__synapseTacticDraftNavigation = navigation;
    return navigation;
  }
  const guards = new Set<CanLeave>();
  let currentKey: string | null = browser.currentEntry.key;
  let restoring: { key: string } | null = null;

  const entryChanged = (event: Event) => {
    // Native fragment pushes and History API pushes/replacements all pass here.
    // A traversal is checked in capture phase before Next processes popstate.
    if ((event as Event & { navigationType: string | null }).navigationType !== "traverse" && restoring === null) {
      currentKey = browser?.currentEntry?.key ?? null;
    }
  };
  function restore(key: string) {
    const attempt = { key };
    restoring = attempt;
    // Settle this attempt only: a newer navigation may supersede it. Clear on
    // success as well as rejection, even if no popstate reaches this listener.
    const settled = () => {
      if (restoring === attempt) {
        restoring = null;
        currentKey = browser?.currentEntry?.key ?? null;
      }
    };
    const result = browser!.traverseTo(key);
    void Promise.all([result.committed, result.finished]).then(settled, settled);
  }
  const pop = (event: PopStateEvent) => {
    const next = browser?.currentEntry?.key;
    if (!next) return;
    if (restoring !== null) {
      event.stopImmediatePropagation();
      if (next === restoring.key) { currentKey = next; restoring = null; }
      else restore(restoring.key);
      return;
    }
    if (currentKey && next !== currentKey && [...guards].some(canLeave => !canLeave())) {
      // popstate cannot be cancelled. Retain the mounted editor while the
      // browser returns to the exact source entry; history.state can be null.
      event.stopImmediatePropagation();
      restore(currentKey);
      return;
    }
    currentKey = next;
  };

  // Install before Next's popstate listener: its eager transition can replace
  // the editor before a later listener runs. Native keys need no history patches.
  if (browser?.currentEntry && typeof browser.traverseTo === "function") {
    browser.addEventListener("currententrychange", entryChanged);
    window.addEventListener("popstate", pop, { capture: true });
  }
  const navigation: DraftNavigation = {
    protect(canLeave) {
      guards.add(canLeave);
      return () => {
        guards.delete(canLeave);
        if (guards.size === 0) {
          currentKey = browser.currentEntry?.key ?? null;
          restoring = null;
        }
      };
    },
  };
  target.__synapseTacticDraftNavigation = navigation;
  return navigation;
}

// Older supported engines have no entry-key traversal. Keep identities and their
// relative order, not offsets: native fragment pushes/replacements bypass the
// History methods, and replacement can leave holes in any numeric counter.
const historyMarker = "__synapseTacticHistory";
type TrackedEntry = { key: string; order: string[]; nullState: boolean };

function trackedEntry(state: unknown): TrackedEntry | null {
  if (!state || typeof state !== "object") return null;
  const entry = (state as Record<string, TrackedEntry>)[historyMarker];
  return typeof entry?.key === "string" && Array.isArray(entry.order) && entry.order.every(key => typeof key === "string")
    ? entry : null;
}

let fallbackEntrySequence = 0;
function entryIdentifier(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `history-${Date.now().toString(36)}-${fallbackEntrySequence++}-${Math.random().toString(36).slice(2)}`;
}

function installHistoryStateNavigation(): DraftNavigation {
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const initial = trackedEntry(history.state);
  // The active entry carries the complete ordering snapshot. A reload retains
  // it, including forward entries; no storage service or sentinel is required.
  const order = initial?.order.slice() ?? [];
  let current = initial?.key ?? entryIdentifier();
  if (!order.includes(current)) order.push(current);
  let restoring: string | null = null;
  const guards = new Set<CanLeave>();

  function stamp(state: unknown, key: string) {
    return {
      ...(state && typeof state === "object" ? state : {}),
      [historyMarker]: {
        key, order: order.slice(),
        nullState: state == null || (trackedEntry(state)?.nullState === true && Object.keys(state as object).length === 1),
      },
    };
  }
  function insert() {
    const key = entryIdentifier();
    // Retaining obsolete keys is intentional: native replace and push-with-one-
    // forward-entry are indistinguishable. Both put the new entry immediately
    // after the source in this ordering, without changing other live entries.
    order.splice(order.indexOf(current) + 1, 0, key);
    return key;
  }
  function observe() {
    const entry = trackedEntry(history.state);
    if (entry && order.includes(entry.key)) return { key: entry.key, created: false };
    const key = insert();
    replace(stamp(history.state, key), "");
    return { key, created: true };
  }
  replace(stamp(history.state, current), "");

  history.pushState = (state, unused, url) => {
    // A native fragment can change the active entry synchronously before its
    // queued popstate. Observe it before stamping a subsequent synchronous push.
    current = observe().key;
    const key = insert();
    push(stamp(state, key), unused, url);
    current = key;
  };
  history.replaceState = (state, unused, url) => {
    current = observe().key;
    replace(stamp(state, current), unused, url);
  };

  function restore() {
    const active = trackedEntry(history.state)!.key;
    if (active === restoring) { current = active; restoring = null; return; }
    // Only direction comes from the ordering. Walk actual browser entries until
    // the exact identity arrives; null-state fragments and replaced holes cannot
    // turn a rank difference into an incorrect history.go offset.
    history.go(order.indexOf(restoring!) > order.indexOf(active) ? 1 : -1);
  }
  window.addEventListener("popstate", event => {
    const next = observe();
    if (restoring !== null) {
      event.stopImmediatePropagation();
      restore();
      return;
    }
    if (!next.created && next.key !== current && [...guards].some(canLeave => !canLeave())) {
      event.stopImmediatePropagation();
      restoring = current;
      restore();
      return;
    }
    current = next.key;
    const state = history.state;
    const entry = trackedEntry(state)!;
    // Refresh the snapshot on every accepted visit, so reloading an older entry
    // keeps knowledge of its forward entries. Preserve Next's own state keys.
    replace({ ...state, [historyMarker]: { ...entry, order: order.slice() } }, "");
    // Native fragment state was null. Keep its event semantics: Next ignores
    // null states but reloads objects lacking its private router keys.
    if (entry.nullState) Object.defineProperty(event, "state", { value: null });
  }, { capture: true });

  return {
    protect(canLeave) {
      guards.add(canLeave);
      return () => {
        guards.delete(canLeave);
        if (guards.size === 0) { current = observe().key; restoring = null; }
      };
    },
  };
}
