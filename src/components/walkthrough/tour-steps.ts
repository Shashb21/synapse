/**
 * The guided tour of the customer app: one step per main place, in the order
 * a plan is built. Each step names the page it lives on and the control to
 * highlight there. Targets are tried in order; the first visible match wins,
 * and the step still shows (without a highlight) when none is on screen.
 */

export type TourTarget = {
  /** CSS selector for candidate elements. */
  selector: string;
  /** When set, only candidates whose text matches. */
  text?: RegExp;
};

export type TourStep = {
  id: "gaps" | "tactics" | "mappings" | "prioritize" | "ideation" | "timeline" | "room";
  place: string;
  href: string;
  title: string;
  /** What to do here with AI on. */
  ai: string;
  /** The manual path while an admin has AI switched off. */
  manual: string;
  targets: TourTarget[];
};

const nav = (href: string): TourTarget => ({ selector: `a[href="${href}"]` });
const heading: TourTarget = { selector: "main h1, h1" };

export const TOUR_STEPS: TourStep[] = [
  {
    id: "gaps",
    place: "Gaps",
    href: "/?place=gaps",
    title: "Start with the evidence gaps",
    ai: "Gaps extracted from your uploaded sources land here with the tactics already mapped and a computed status. Validate each gap, tag its treatment settings, and split or rewrite any Partial gap.",
    manual:
      "AI is off, so nothing is extracted for you. Use Add gap to enter each evidence gap by hand, tag its treatment settings, then validate it. Split or rewrite Partial gaps yourself.",
    targets: [{ selector: "button", text: /^\s*add gaps?\s*$/i }, { selector: '[aria-label="Filter gaps"]' }, nav("/?place=gaps"), heading],
  },
  {
    id: "tactics",
    place: "Tactics",
    href: "/?place=tactics",
    title: "Record the tactics you already have",
    ai: "Tactics are the studies and activities that answer gaps. Library tactics come in with your sources; after Prioritize, create proposed tactics here for the Open gaps.",
    manual:
      "Enter the studies and activities in your library with Add tactics, then, after Prioritize, create proposed tactics for the Open gaps by hand.",
    targets: [
      { selector: "button", text: /create tactic|add tactics?/i },
      nav("/?place=tactics"),
      heading,
    ],
  },
  {
    id: "mappings",
    place: "Mapping table",
    href: "/mappings",
    title: "Map tactics to gaps",
    ai: "One row per gap. The model proposes which tactics cover it and how well; accept each row or edit it with a short rationale.",
    manual: "One row per gap. Record which tactics cover it and how well, with a short rationale for each row.",
    targets: [{ selector: "table" }, nav("/mappings"), heading],
  },
  {
    id: "prioritize",
    place: "Prioritize",
    href: "/?place=plan",
    title: "Prioritize the Open gaps",
    ai: "Pick a treatment setting and two axes. Open gaps land on the matrix as a first draft using your setup context; drag them to adjust, then validate each band.",
    manual: "Pick a treatment setting and two axes, then place each Open gap yourself: type its scores or band, or drop it on the matrix, and validate it.",
    targets: [{ selector: 'nav[aria-label="Setting"]' }, { selector: 'section[aria-label="Gaps not placed yet"]' }, nav("/?place=plan"), heading],
  },
  {
    id: "ideation",
    place: "Ideation",
    href: "/ideation",
    title: "Ideate new tactics",
    ai: "For each High-priority Open gap the model proposes candidate studies, critiqued and ranked. Accept the ones worth doing; they become proposed tactics.",
    manual: "AI is off, so no candidates are proposed. Add proposed tactics for each High-priority Open gap by hand.",
    targets: [{ selector: "button", text: /propose|ideate|generate/i }, heading],
  },
  {
    id: "timeline",
    place: "Timeline",
    href: "/timeline",
    title: "Lay out the IEGP timeline",
    ai: "The living plan as a Gantt. The model drafts dates and dependencies against your key decision dates; move bars, add activities and lock the plan.",
    manual: "The living plan as a Gantt. Use Add activity to place each tactic, set its dates and dependencies against your key decision dates, and move bars as plans change.",
    targets: [{ selector: "button", text: /^\s*add activity\s*$/i }, nav("/timeline"), heading],
  },
  {
    id: "room",
    place: "Room",
    href: "/room",
    title: "Present in the Room",
    ai: "Room is a presenter view, like PowerPoint's: the real pages are your slides, with notes, a timer and an audience window for the projector. Edit live as the client team decides, and use Breakouts for small groups.",
    manual: "Room is a presenter view, like PowerPoint's: the real pages are your slides, with notes, a timer and an audience window for the projector. Everything is captured by hand while AI is off.",
    targets: [{ selector: '[aria-label="Prep or Room mode"]' }, heading],
  },
];

/** The first visible element for a step, if any is on the page. */
export function findTourTarget(step: TourStep, root: ParentNode = document): HTMLElement | null {
  for (const target of step.targets) {
    let candidates: HTMLElement[] = [];
    try {
      candidates = [...root.querySelectorAll<HTMLElement>(target.selector)];
    } catch {
      continue;
    }
    const match = candidates.find((el) => {
      if (target.text && !target.text.test(el.textContent ?? "")) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (match) return match;
  }
  return null;
}

/** Whether the browser is on the step's page (path and, when given, `place`). */
export function onStepPage(step: TourStep, pathname: string, search: URLSearchParams): boolean {
  const url = new URL(step.href, "http://local");
  if (url.pathname !== pathname) return false;
  const place = url.searchParams.get("place");
  if (!place) return true;
  return search.get("place") === place;
}
