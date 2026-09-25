/**
 * Room slides are the real customer app pages, in plan order. Nothing here is a
 * bespoke presentation screen: each slide is the page the consultant already
 * works in, shown chrome-free (see src/components/room/present-frame.ts).
 */

export type RoomSlide = {
  id: string;
  title: string;
  /** The real page this slide shows. */
  href: string;
  hint: string;
};

export const ROOM_SLIDES: readonly RoomSlide[] = [
  { id: "context", title: "Context", href: "/setup", hint: "Asset, indication and planning context" },
  { id: "gaps", title: "Gaps", href: "/?place=gaps", hint: "Evidence gaps with their mapped tactics and status" },
  { id: "mappings", title: "Mappings", href: "/mappings", hint: "Gap ↔ tactic mapping table" },
  { id: "prioritize", title: "Prioritize", href: "/?place=plan", hint: "The prioritization matrix" },
  { id: "tactics", title: "Tactics", href: "/?place=tactics", hint: "Tactics for prioritized open gaps" },
  { id: "ideation", title: "Ideation", href: "/ideation", hint: "New tactic ideas for open gaps" },
  { id: "timeline", title: "Timeline", href: "/timeline", hint: "The IEGP as a Gantt" },
];

export const FIRST_SLIDE_ID = ROOM_SLIDES[0].id;

export function slideById(id: string | null | undefined): RoomSlide | undefined {
  return ROOM_SLIDES.find((slide) => slide.id === id);
}

export function slideIndex(id: string | null | undefined): number {
  const index = ROOM_SLIDES.findIndex((slide) => slide.id === id);
  return index < 0 ? 0 : index;
}

/** The slide `step` away from `id`, clamped to the deck (no wrap, like PowerPoint). */
export function stepSlide(id: string | null | undefined, step: number): RoomSlide {
  const index = Math.min(Math.max(slideIndex(id) + step, 0), ROOM_SLIDES.length - 1);
  return ROOM_SLIDES[index];
}

/** The next slide, or null on the last one. */
export function nextSlideOf(id: string | null | undefined): RoomSlide | null {
  const index = slideIndex(id);
  return index + 1 < ROOM_SLIDES.length ? ROOM_SLIDES[index + 1] : null;
}

export const PRESENT_PARAM = "present";

/**
 * A page path the room may show: same-origin, relative, and never the room
 * itself (a slide that shows the console would nest forever).
 */
export function isShowableHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || href.length > 2000) return false;
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return false;
  const path = href.split(/[?#]/)[0];
  if (path === "/room" || path.startsWith("/room/") || path.startsWith("/api/")) return false;
  if (path === "/presentation" || path.startsWith("/accuracy")) return false;
  return true;
}

/** `href` with `?present=1`, the flag the shells can read to hide their chrome. */
export function presentHref(href: string): string {
  const [pathAndQuery, hash = ""] = href.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  const params = new URLSearchParams(query);
  params.set(PRESENT_PARAM, "1");
  return `${path}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

/** The page path without the present flag (what the presenter is showing). */
export function stripPresent(href: string): string {
  const [pathAndQuery, hash = ""] = href.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  const params = new URLSearchParams(query);
  params.delete(PRESENT_PARAM);
  const rest = params.toString();
  return `${path}${rest ? `?${rest}` : ""}${hash ? `#${hash}` : ""}`;
}
