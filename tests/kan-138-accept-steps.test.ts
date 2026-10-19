import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptDemoStep, demoStepFor } from "@/lib/demo/accept-steps";

/** KAN-138: "Accept all as in demo" makes the calls a presenter's clicks would. */

afterEach(() => vi.unstubAllGlobals());

describe("which step a page is", () => {
  it("maps each walkthrough place to its step, and nothing else", () => {
    expect(demoStepFor("/", "gaps")).toBe("gaps");
    expect(demoStepFor("/", "plan")).toBe("prioritize");
    expect(demoStepFor("/", "tactics")).toBe("ideation");
    expect(demoStepFor("/ideation", null)).toBe("ideation");
    expect(demoStepFor("/timeline", null)).toBe("timeline");
    expect(demoStepFor("/", "upload")).toBeNull();
    expect(demoStepFor("/needs", null)).toBeNull();
  });
});

type Call = { url: string; body: Record<string, unknown> | null };

function stubServer(pending: unknown[], replies: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/demo/pending") return Response.json(pending[Math.min(reads++, pending.length - 1)]);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body });
      return Response.json(replies[String(body?.stage ?? body?.action)] ?? { ok: true });
    }),
  );
  return calls;
}

const base = {
  gaps: { partial: [], unvalidated: [], wizard_complete: true, tactics_unlocked: true },
  prioritize: { suggested: [] },
  ideation: { proposed: [] },
  timeline: { dependencies: [], estimates: false },
};

describe("accepting a step", () => {
  it("gaps: splits each Partial gap as proposed, then confirms every gap and moves the plan on", async () => {
    const calls = stubServer(
      [
        { ...base, gaps: { partial: [{ id: "GAP-003", name: "Elderly", statement: "Elderly CE" }], unvalidated: [], wizard_complete: false, tactics_unlocked: false } },
        { ...base, gaps: { partial: [], unvalidated: ["GAP-001", "GAP-014"], wizard_complete: false, tactics_unlocked: false } },
      ],
      {
        S6: {
          run_id: "run_s6",
          output: { mode: "llm", proposal: { addressed_name: "Elderly descriptive", open_name: "Elderly comparative", addressed_tactic_ids: ["TAC-002"] } },
        },
      },
    );
    expect(await acceptDemoStep("gaps")).toBe(3);
    expect(calls.map((c) => c.body?.action ?? c.body?.stage)).toEqual([
      "S6",
      "split_partial_gap",
      "validate_gap",
      "validate_gap",
      "complete_wizard",
    ]);
    expect(calls[1]!.body).toMatchObject({
      parent_gap_id: "GAP-003",
      originating_run_id: "run_s6",
      addressed_name: "Elderly descriptive",
      open_name: "Elderly comparative",
      tactic_ids: "TAC-002",
    });
  });

  it("gaps: keeps a Partial gap whole, as Open, when no split holds up", async () => {
    const calls = stubServer(
      [
        { ...base, gaps: { partial: [{ id: "GAP-013", name: "Community re-biopsy rate", statement: "How often?" }], unvalidated: [], wizard_complete: true, tactics_unlocked: true } },
        { ...base, gaps: { partial: [], unvalidated: ["GAP-013"], wizard_complete: true, tactics_unlocked: true } },
      ],
      { S6: { run_id: "run_s6", output: { mode: "llm", proposal: null } } },
    );
    await acceptDemoStep("gaps");
    expect(calls.map((c) => c.body?.action ?? c.body?.stage)).toEqual(["S6", "rewrite_partial_gap", "validate_gap"]);
    expect(calls[1]!.body).toMatchObject({ gap_id: "GAP-013", name: "Community re-biopsy rate", statement: "How often?", status: "validated_open" });
  });

  it("prioritize, ideation and timeline accept what the AI suggested", async () => {
    let calls = stubServer([
      { ...base, gaps: { ...base.gaps, tactics_unlocked: false }, prioritize: { suggested: [{ gap_id: "GAP-001", band: "high" }] } },
    ]);
    await acceptDemoStep("prioritize");
    expect(calls[0]!.body).toMatchObject({ action: "validate_band", gap_id: "GAP-001", band: "high" });
    expect(calls[1]!.body).toMatchObject({ action: "unlock_tactics" });

    calls = stubServer([{ ...base, ideation: { proposed: ["IDEA-1", "IDEA-2"] } }]);
    expect(await acceptDemoStep("ideation")).toBe(2);
    expect(calls.map((c) => c.body?.decision)).toEqual(["accept", "accept"]);

    calls = stubServer([{ ...base, timeline: { dependencies: [{ id: "ACT-TAC-005", upstream_id: "ACT-TAC-002" }], estimates: true } }]);
    expect(await acceptDemoStep("timeline")).toBe(2);
    expect(calls.map((c) => c.body?.action)).toEqual(["review_dependency", "accept_estimates"]);
  });

  it("stops and says why when a step fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/demo/pending"
          ? Response.json({ ...base, ideation: { proposed: ["IDEA-1"] } })
          : Response.json({ error: "Proposal IDEA-1 was already decided." }, { status: 409 }),
      ),
    );
    await expect(acceptDemoStep("ideation")).rejects.toThrow("Proposal IDEA-1 was already decided.");
  });
});
