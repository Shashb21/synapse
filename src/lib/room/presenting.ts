import { PRESENT_PARAM } from "@/lib/room/slides";

/**
 * Whether this page is a Room slide: framed by the presenter or audience view,
 * or opened with `?present=1`. A slide shows the page; it never starts work of
 * its own (an automatic AI run, the walkthrough) behind the presenter's back.
 */
export function isPresenting(win: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win) return false;
  try {
    if (new URLSearchParams(win.location.search).get(PRESENT_PARAM) === "1") return true;
    return win.self !== win.top;
  } catch {
    // Reading a cross-origin parent throws: the page is framed.
    return true;
  }
}
