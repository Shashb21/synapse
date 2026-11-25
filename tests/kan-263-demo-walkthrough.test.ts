import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptDemoIdeation, acceptDemoStep, loadDemoIdeationReview } from "@/lib/demo/accept-steps";

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { "content-type": "application/json" },
});

afterEach(() => vi.unstubAllGlobals());

describe("KAN-263 customer demo approval sequence", () => {
  it("carries reviewed versions and reasons through the existing client paths", async () => {
    const checklist = {
      gaps: {
        partial: [
          { id: "GAP-001", name: "Suitable to split", statement: "Two scopes", resolution: "parent-snapshot" },
          { id: "GAP-002", name: "Keep open", statement: "One scope", resolution: "kept-snapshot" },
        ],
        unvalidated: ["GAP-003"], wizard_complete: false, tactics_unlocked: false,
      },
      prioritize: { suggested: [{ gap_id: "GAP-003", band: "high", version: "placement-snapshot" }] },
      ideation: { proposed: [{ id: "PROP-003", name: "Comparative study", version: "proposal-snapshot" }] },
      workspace_id: "velmara-workspace",
      timeline: { dependencies: [{ id: "ACT-TAC-004", upstream_id: "ACT-TAC-003" }], estimates: true },
    };
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/demo/pending") return json(checklist);
      const body = JSON.parse(options?.body as string);
      if (path === "/api/modules" && body.input.gap_id === "GAP-001") {
        return json({ run_id: "run-1", execution_source: "demo_replay", output: { mode: "llm", proposal: {
          addressed_name: "Addressed scope", open_name: "Remaining scope", addressed_tactic_ids: ["TAC-003"],
          expected_resolution: "proposal-parent-snapshot",
        } } });
      }
      if (path === "/api/modules") return json({ execution_source: "demo_replay", output: { mode: "llm", proposal: null } });
      if (path === "/api/demo/ideation-approvals") return json({ ok: true, accepted: 1 });
      return json({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(acceptDemoStep("gaps")).resolves.toBe(3);
    await expect(acceptDemoStep("prioritize")).resolves.toBe(1);
    await expect(acceptDemoIdeation(await loadDemoIdeationReview())).resolves.toBe(1);
    await expect(acceptDemoStep("timeline")).resolves.toBe(2);

    const requests = fetch.mock.calls
      .filter(([path]) => path !== "/api/demo/pending")
      .map(([path, options]) => [path, JSON.parse(options?.body as string)]);
    expect(requests).toEqual([
      ["/api/modules", { stage: "S6", input: { gap_id: "GAP-001" } }],
      ["/api/iegp", expect.objectContaining({ action: "split_partial_gap", originating_run_id: "run-1", expected_resolution: "proposal-parent-snapshot", note: "Accepted as in the demo" })],
      ["/api/modules", { stage: "S6", input: { gap_id: "GAP-002" } }],
      ["/api/iegp", expect.objectContaining({ action: "rewrite_partial_gap", expected_resolution: "kept-snapshot", status: "validated_open" })],
      ["/api/iegp", expect.objectContaining({ action: "validate_gap", gap_id: "GAP-003" })],
      ["/api/iegp", expect.objectContaining({ action: "complete_wizard" })],
      ["/api/plan", expect.objectContaining({ action: "accept_priority_suggestion", gap_id: "GAP-003", expected_version: "placement-snapshot", reason: "Accepted as in the demo" })],
      ["/api/iegp", expect.objectContaining({ action: "unlock_tactics" })],
      ["/api/demo/ideation-approvals", { workspace_id: "velmara-workspace", proposals: [{ id: "PROP-003", expected_version: "proposal-snapshot" }], rationale: "Accepted as in the demo" }],
      ["/api/plan", expect.objectContaining({ action: "review_dependency", id: "ACT-TAC-004", upstream_id: "ACT-TAC-003" })],
      ["/api/plan", expect.objectContaining({ action: "accept_estimates" })],
    ]);
  });

  it("stops before any approval when the recorded S6 proposal is missing", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ gaps: { partial: [{ id: "GAP-001" }] } }))
      .mockResolvedValueOnce(json({ safe_error: true, code: "demo_replay_miss", error: "Reset demo to follow the Velmara walkthrough." }, 409));
    vi.stubGlobal("fetch", fetch);
    await expect(acceptDemoStep("gaps")).rejects.toThrow("Reset demo");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("submits the displayed selections and opening versions together without fetching them again", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({
      workspace_id: "velmara-workspace",
      ideation: { proposed: [
        { id: "PROP-001", name: "First study", version: "first-review" },
        { id: "PROP-002", name: "Second study", version: "second-review" },
      ] },
    })).mockResolvedValueOnce(json({ ok: true, accepted: 2 }));
    vi.stubGlobal("fetch", fetch);

    const review = await loadDemoIdeationReview();
    expect(review.proposals.map(proposal => proposal.name)).toEqual(["First study", "Second study"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(acceptDemoIdeation(review)).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe("/api/demo/ideation-approvals");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      workspace_id: "velmara-workspace",
      proposals: [
        { id: "PROP-001", expected_version: "first-review" },
        { id: "PROP-002", expected_version: "second-review" },
      ],
      rationale: "Accepted as in the demo",
    });
  });

  it("shows a rejected batch response without advancing or resubmitting the ideas", async () => {
    const message = "Workspace changes are being saved. Open the demo ideas again once the changes finish.";
    const fetch = vi.fn().mockResolvedValueOnce(json({ safe_error: true, request_outcome: "rejected", error: message }, 409));
    vi.stubGlobal("fetch", fetch);

    await expect(acceptDemoIdeation({ workspace_id: "velmara-workspace", proposals: [
      { id: "PROP-001", name: "First study", version: "first-review" },
      { id: "PROP-002", name: "Second study", version: "second-review" },
    ] })).rejects.toMatchObject({ message, outcome: "rejected", status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
