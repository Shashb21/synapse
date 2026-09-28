import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes read the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { POST as iegpPost } from "@/app/api/iegp/route";
import { createTacticStatus, loadState, optionalTacticDate, resetDemoSetup } from "@/lib/iegp/store";
import { tacticCountsTowardAddressing } from "@/lib/iegp/engine";
import { CREATE_TACTIC_STATUSES } from "@/lib/iegp/enums";
import { resetWorkspaceModules } from "@/modules/kernel/db";

const ACTOR = { actor_name: "Create Tactic Test", actor_function: "medical_affairs" } as const;

async function createTactic(fields: Record<string, string>) {
  const res = await iegpPost(
    new Request("http://localhost/api/iegp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ACTOR,
        action: "create_tactic",
        origin: "tactics",
        type: "rwe_study",
        evidence_question: "What is real-world persistence at 12 months?",
        note: "",
        ...fields,
      }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { error?: string } };
}

async function tacticNamed(name: string) {
  return (await loadState()).tactics.find((t) => t.name === name);
}

describe("create tactic status and dates", () => {
  beforeEach(async () => {
    await resetDemoSetup();
    await resetWorkspaceModules();
  });

  it("offers proposed, planned, ongoing and completed — never cancelled", () => {
    expect([...CREATE_TACTIC_STATUSES]).toEqual(["proposed", "planned", "ongoing", "completed"]);
    expect(createTacticStatus(undefined)).toBe("proposed");
    expect(createTacticStatus("  ")).toBe("proposed");
    expect(createTacticStatus("ongoing")).toBe("ongoing");
    expect(() => createTacticStatus("cancelled")).toThrow(/Proposed, Planned, Ongoing or Completed/);
    expect(() => createTacticStatus("done")).toThrow(/Proposed, Planned, Ongoing or Completed/);
  });

  it("keeps proposed as the default when no status is sent", async () => {
    const res = await createTactic({ name: "Default status idea" });
    expect(res.status).toBe(200);
    const tactic = await tacticNamed("Default status idea");
    expect(tactic?.status).toBe("proposed");
    expect(tactic?.start_date).toBeNull();
    expect(tactic?.evidence_available).toBeNull();
    expect(tacticCountsTowardAddressing(tactic!)).toBe(false);
  });

  it.each(["planned", "ongoing", "completed"] as const)(
    "enters an existing real study as %s, which counts toward coverage",
    async (status) => {
      const name = `Existing ${status} registry`;
      const res = await createTactic({ name, status });
      expect(res.status).toBe(200);
      const tactic = await tacticNamed(name);
      expect(tactic?.status).toBe(status);
      expect(tactic?.lifecycle_stage).toBe("recorded");
      expect(tacticCountsTowardAddressing(tactic!)).toBe(true);
    },
  );

  it("stores the start and evidence-available dates for the timeline", async () => {
    const res = await createTactic({
      name: "Dated ongoing study",
      status: "ongoing",
      start_date: "2026-03-01",
      evidence_available: "2027-06",
    });
    expect(res.status).toBe(200);
    const tactic = await tacticNamed("Dated ongoing study");
    expect(tactic?.start_date).toBe("2026-03-01");
    expect(tactic?.evidence_available).toBe("2027-06");
  });

  it("rejects an unknown status and a malformed date with a readable message", async () => {
    const bad = await createTactic({ name: "Cancelled at birth", status: "cancelled" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Proposed, Planned, Ongoing or Completed/);
    expect(await tacticNamed("Cancelled at birth")).toBeUndefined();

    const date = await createTactic({ name: "Bad date study", status: "planned", start_date: "March 2026" });
    expect(date.status).toBe(400);
    expect(date.json.error).toBe("Start date must be a date (YYYY-MM-DD) or blank.");
    expect(await tacticNamed("Bad date study")).toBeUndefined();
    expect(() => optionalTacticDate("evidence_available", "2027/01/01")).toThrow(/Evidence available/);
    expect(optionalTacticDate("start_date", "")).toBeNull();
  });
});
