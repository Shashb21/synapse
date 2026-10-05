/** Pure cue scoring shared by legacy S8 and isolated accuracy replay. */
import type { PriorityAxis } from "./axes";

/** Score configured axes from text cues and strategic importance without I/O. */
export function heuristicScores(args: {
  gap: { name: string; statement: string; domain: string };
  axes: PriorityAxis[];
  importance: number;
}): { scores: Record<string, number>; rationale: string } {
  const hay = `${args.gap.name} ${args.gap.statement} ${args.gap.domain}`.toLowerCase();
  const scores: Record<string, number> = {};
  const hits: string[] = [];
  for (const axis of args.axes) {
    const matched = axis.cues.filter((cue) => hay.includes(cue.toLowerCase()));
    const base = 38 + Math.min(4, matched.length) * 11;
    const importanceBump = axis.id === "decision_impact" ? (args.importance - 3) * 6 : 0;
    scores[axis.id] = Math.max(0, Math.min(100, Math.round(base + importanceBump)));
    if (matched.length > 0) hits.push(`${axis.label}: ${matched.slice(0, 3).join(", ")}`);
  }
  return {
    scores,
    rationale: hits.length
      ? `Signals in the gap text — ${hits.join("; ")}.`
      : "No axis cues found in the gap text; scored at the neutral baseline.",
  };
}

