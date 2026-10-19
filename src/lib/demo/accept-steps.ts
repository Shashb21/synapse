import { postJson } from "@/lib/post-json";

/**
 * "Accept all as in demo" (KAN-138): makes, for one walkthrough step, the same
 * calls a presenter's clicks would, accepting every AI suggestion. The recorded
 * run was made with these same steps, so the replay stays on script.
 */

export type DemoStep = "gaps" | "prioritize" | "ideation" | "timeline";

export const DEMO_STEP_LABELS: Record<DemoStep, string> = {
  gaps: "confirm every gap (splitting Partially Addressed ones as proposed)",
  prioritize: "validate every suggested priority band",
  ideation: "accept every proposed tactic",
  timeline: "accept every proposed dependency and date estimate",
};

const NOTE = "Accepted as in the demo";

type Pending = {
  gaps: { partial: string[]; unvalidated: string[]; wizard_complete: boolean; tactics_unlocked: boolean };
  prioritize: { suggested: { gap_id: string; band: string }[] };
  ideation: { proposed: string[] };
  timeline: { dependencies: { id: string; upstream_id: string }[]; estimates: boolean };
};

type SplitProposal = {
  addressed_name: string;
  addressed_statement?: string;
  open_name: string;
  open_statement?: string;
  addressed_tactic_ids: string[];
};

/** The walkthrough step a page belongs to, or null where there is nothing to accept. */
export function demoStepFor(pathname: string, place: string | null): DemoStep | null {
  if (pathname === "/timeline") return "timeline";
  if (pathname === "/ideation") return "ideation";
  if (pathname !== "/") return null;
  if (place === "gaps") return "gaps";
  if (place === "plan") return "prioritize";
  if (place === "tactics") return "ideation";
  return null;
}

async function pending(): Promise<Pending> {
  const res = await fetch("/api/demo/pending", { cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as Pending & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Could not read the demo's next decisions (HTTP ${res.status}).`);
  return json;
}

async function post(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await postJson(url, body);
  const json = (res.json ?? {}) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `${String(body.action ?? body.stage)} failed (HTTP ${res.status}).`);
  return json;
}

/** Runs one step's accept-all. `onProgress` hears a short line per decision. Returns how many decisions were made. */
export async function acceptDemoStep(step: DemoStep, onProgress: (line: string) => void = () => undefined): Promise<number> {
  let done = 0;
  if (step === "gaps") {
    const before = await pending();
    for (const gap_id of before.gaps.partial) {
      onProgress(`Proposing a split for ${gap_id}…`);
      const run = await post("/api/modules", { stage: "S6", input: { gap_id } });
      const output = run.output as { mode?: string; proposal?: SplitProposal | null } | undefined;
      const proposal = output?.proposal;
      if (!proposal) throw new Error(`No split was proposed for ${gap_id}; split it by hand on its gap page.`);
      await post("/api/iegp", {
        action: "split_partial_gap",
        ...(output?.mode === "llm" && typeof run.run_id === "string" ? { originating_run_id: run.run_id } : {}),
        parent_gap_id: gap_id,
        addressed_name: proposal.addressed_name,
        open_name: proposal.open_name,
        ...(proposal.addressed_statement?.trim() ? { addressed_statement: proposal.addressed_statement.trim() } : {}),
        ...(proposal.open_statement?.trim() ? { open_statement: proposal.open_statement.trim() } : {}),
        tactic_ids: proposal.addressed_tactic_ids.join(","),
        open_tactic_ids: "",
        note: NOTE,
      });
      done += 1;
    }
    const after = await pending();
    for (const gap_id of after.gaps.unvalidated) {
      onProgress(`Confirming ${gap_id}…`);
      await post("/api/iegp", { action: "validate_gap", gap_id, note: NOTE });
      done += 1;
    }
    if (!after.gaps.wizard_complete) await post("/api/iegp", { action: "complete_wizard", note: NOTE });
    if (!after.gaps.tactics_unlocked) await post("/api/iegp", { action: "unlock_tactics", note: NOTE });
    return done;
  }
  const now = await pending();
  if (step === "prioritize") {
    for (const { gap_id, band } of now.prioritize.suggested) {
      onProgress(`Validating ${gap_id} as ${band}…`);
      await post("/api/plan", { action: "validate_band", gap_id, band, rationale: NOTE });
      done += 1;
    }
    return done;
  }
  if (step === "ideation") {
    for (const id of now.ideation.proposed) {
      onProgress(`Accepting ${id}…`);
      await post("/api/plan", { action: "decide_proposal", id, decision: "accept", rationale: NOTE });
      done += 1;
    }
    return done;
  }
  for (const dep of now.timeline.dependencies) {
    onProgress(`Accepting a dependency of ${dep.id}…`);
    await post("/api/plan", { action: "review_dependency", id: dep.id, upstream_id: dep.upstream_id, decision: "accept", rationale: NOTE });
    done += 1;
  }
  if (now.timeline.estimates) {
    onProgress("Accepting the date estimates…");
    await post("/api/plan", { action: "accept_estimates", rationale: NOTE });
    done += 1;
  }
  return done;
}
