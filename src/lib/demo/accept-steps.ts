import { postJson, RequestOutcomeError } from "@/lib/post-json";

/**
 * "Accept all as in demo" (KAN-138): makes, for one walkthrough step, the same
 * customer decisions in the recorded walkthrough.
 */

export type DemoStep = "gaps" | "prioritize" | "ideation" | "timeline";

export const DEMO_STEP_LABELS: Record<DemoStep, string> = {
  gaps: "confirm every gap (splitting Partially Addressed ones as proposed, or keeping them Open where no split holds up)",
  prioritize: "validate every suggested priority band and open tactic ideation",
  ideation: "accept every proposed tactic",
  timeline: "accept every proposed dependency and date estimate",
};

const NOTE = "Accepted as in the demo";

type Pending = {
  workspace_id: string;
  gaps: { partial: { id: string; name: string; statement: string; resolution: string }[]; unvalidated: string[]; wizard_complete: boolean; tactics_unlocked: boolean };
  prioritize: { suggested: { gap_id: string; band: string; version: string }[] };
  ideation: { proposed: { id: string; name: string; version: string }[] };
  timeline: { dependencies: { id: string; upstream_id: string }[]; estimates: boolean };
};

type SplitProposal = {
  addressed_name: string;
  addressed_statement?: string;
  open_name: string;
  open_statement?: string;
  addressed_tactic_ids: string[];
  expected_resolution?: string;
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
  const json = (await res.json().catch(() => ({}))) as Pending & { safe_error?: boolean; error?: string };
  if (!res.ok) {
    const message = json?.safe_error && json.error ? json.error : "Could not read the demo's next decisions.";
    throw new RequestOutcomeError(message, "rejected", res.status);
  }
  return json;
}

async function post(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await postJson(url, body);
  const json = (res.json ?? {}) as Record<string, unknown>;
  if (!res.ok) {
    throw new RequestOutcomeError(res.json.error ?? "Could not save the demo decision.", res.outcome, res.status);
  }
  return json;
}

export type DemoIdeationReview = {
  workspace_id: string;
  proposals: Pending["ideation"]["proposed"];
};

export async function loadDemoIdeationReview(): Promise<DemoIdeationReview> {
  const now = await pending();
  return { workspace_id: now.workspace_id, proposals: now.ideation.proposed };
}

export async function acceptDemoIdeation(review: DemoIdeationReview): Promise<number> {
  if (!review.proposals.length) return 0;
  const result = await post("/api/demo/ideation-approvals", {
    workspace_id: review.workspace_id,
    proposals: review.proposals.map(({ id, version }) => ({ id, expected_version: version })),
    rationale: NOTE,
  });
  if (result.accepted !== review.proposals.length) {
    throw new RequestOutcomeError("Could not confirm the selected ideas were accepted. Check Ideation before trying again.", "unknown", 200);
  }
  return result.accepted;
}

/** Runs one step's accept-all. `onProgress` hears a short line per decision. Returns how many decisions were made. */
export async function acceptDemoStep(step: Exclude<DemoStep, "ideation">, onProgress: (line: string) => void = () => undefined): Promise<number> {
  let done = 0;
  if (step === "gaps") {
    const before = await pending();
    for (const gap of before.gaps.partial) {
      const gap_id = gap.id;
      onProgress(`Proposing a split for ${gap_id}…`);
      const run = await post("/api/modules", { stage: "S6", input: { gap_id } });
      const output = run.output as { mode?: string; proposal?: SplitProposal | null } | undefined;
      const proposal = output?.proposal;
      if (!proposal) {
        // The model's judge found no split that holds up: keep the gap whole, as Open.
        onProgress(`Keeping ${gap_id} as Open…`);
        await post("/api/iegp", { action: "rewrite_partial_gap", gap_id, expected_resolution: gap.resolution, name: gap.name, statement: gap.statement, status: "validated_open", note: NOTE });
        done += 1;
        continue;
      }
      await post("/api/iegp", {
        action: "split_partial_gap",
        ...(output?.mode === "llm" && typeof run.run_id === "string" ? { originating_run_id: run.run_id } : {}),
        parent_gap_id: gap_id,
        expected_resolution: proposal.expected_resolution ?? gap.resolution,
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
    return done;
  }
  const now = await pending();
  if (step === "prioritize") {
    for (const { gap_id, band, version } of now.prioritize.suggested) {
      onProgress(`Validating ${gap_id} as ${band}…`);
      await post("/api/plan", { action: "accept_priority_suggestion", gap_id, band, expected_version: version, reason: NOTE });
      done += 1;
    }
    // Every Open gap banded: tactic ideation opens.
    if (!now.gaps.tactics_unlocked) await post("/api/iegp", { action: "unlock_tactics", note: NOTE });
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
