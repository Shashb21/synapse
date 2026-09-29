import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The plan API reads the session cookie; outside a request there is none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import "@/modules";
import { POST as planPost } from "@/app/api/plan/route";
import { field, fieldLabel, optionalMonths, optionalScore } from "@/app/api/plan/field-errors";
import { scoreError } from "@/components/prioritize/score-input";
import { loadAxes } from "@/modules/stages/s8-prioritization/axes";
import { setPlacement } from "@/modules/stages/s8-prioritization/module";

const ACTOR = { name: "Field Errors Test", function: "medical_affairs" as const };

async function post(body: Record<string, unknown>) {
  const res = await planPost(
    new Request("http://localhost/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_name: ACTOR.name, actor_function: ACTOR.function, ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { error?: string } };
}

describe("plan API field errors name what the person sees", () => {
  it("labels request fields instead of echoing their names", () => {
    expect(fieldLabel("start_date")).toBe("Start date");
    expect(fieldLabel("readout_lag_months")).toBe("Readout lag (months)");
    expect(fieldLabel("some_new_field")).toBe("Some new field");
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date (YYYY-MM-DD)");
    expect(() => field(date, "next spring", "start_date")).toThrow("Start date must be a date (YYYY-MM-DD).");
    expect(() => field(z.enum(["high", "medium", "low", "defer"]), "urgent", "band")).toThrow(
      "Band must be one of: high, medium, low, defer.",
    );
    expect(() => optionalScore(150, "Payer / HTA relevance score")).toThrow(
      "Payer / HTA relevance score must be a number from 0 to 100.",
    );
    expect(optionalScore("", "Any score")).toBeUndefined();
    expect(optionalScore("42", "Any score")).toBe(42);
    expect(() => optionalMonths("soon", "duration_months")).toThrow("Duration (months) must be a number of months.");
  });

  it("checks a typed score on the client with the axis label", () => {
    expect(scoreError("Payer / HTA relevance", "150")).toBe(
      "Payer / HTA relevance score must be a number from 0 to 100.",
    );
    expect(scoreError("Feasibility", "-1")).toMatch(/^Feasibility score must be/);
    expect(scoreError("Feasibility", "abc")).toMatch(/^Feasibility score must be/);
    expect(scoreError("Feasibility", "")).toBeNull();
    expect(scoreError("Feasibility", "0")).toBeNull();
    expect(scoreError("Feasibility", "100")).toBeNull();
  });

  it("set_placement refuses an out-of-range score by its axis label, never y_score", async () => {
    const axes = await loadAxes();
    const payer = axes.axes.find((axis) => axis.id === "payer_value")!;
    const feasibility = axes.axes.find((axis) => axis.id === "feasibility")!;
    const res = await post({
      action: "set_placement",
      gap_id: "GAP-ANY",
      x_axis: feasibility.id,
      y_axis: payer.id,
      y_score: "150",
      x_score: "60",
      rationale: "Out of range on purpose",
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(`${payer.label} score must be a number from 0 to 100.`);
    expect(res.json.error).not.toMatch(/y_score|x_score|payer_value/);

    const bySetter = await post({
      action: "set_placement",
      gap_id: "GAP-ANY",
      axis_scores: { feasibility: -5 },
      rationale: "Out of range on purpose",
    });
    expect(bySetter.json.error).toBe(`${feasibility.label} score must be a number from 0 to 100.`);

    await expect(
      setPlacement({ gap_id: "GAP-ANY", axis_scores: { payer_value: 101 }, rationale: "Direct call", actor: ACTOR }),
    ).rejects.toThrow(`${payer.label} score must be a number from 0 to 100.`);
  });

  it("timeline date errors use the field label", async () => {
    const res = await post({ action: "move_activity", id: "ACT-ANY", start_date: "next spring", rationale: "Vague" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Start date must be a date (YYYY-MM-DD).");
  });
});
