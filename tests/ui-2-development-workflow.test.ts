/** Workflow guidance uses persisted facts, never navigation or loaded defaults. */
import { describe, expect, it } from "vitest";
import { developmentWorkflow, type WorkflowFacts } from "../src/components/development/development-workflow";

const empty: WorkflowFacts = { history: "ready", latestStatus: null, savedSettings: false, deliveryAvailable: true };
describe("Development workflow", () => {
  it("starts a new draft at Documents without claiming settings are saved", () => {
    const result = developmentWorkflow(false, empty);
    expect(result.step).toBe("documents");
    expect(result.states).toEqual({ documents: "Not started", settings: "Not started", run: "Not started", results: "Not started" });
  });
  it("guides saved sources to settings before their first run", () => {
    const result = developmentWorkflow(true, empty);
    expect(result.step).toBe("settings");
    expect(result.states.documents).toBe("Complete");
    expect(result.states.settings).toBe("Not started");
  });
  it.each(["queued", "running"])("guides an active %s run to progress", status => {
    const result = developmentWorkflow(true, { ...empty, latestStatus: status, savedSettings: true });
    expect(result.step).toBe("run");
    expect(result.states.run).toBe("In progress");
    expect(result.states.settings).toBe("Complete");
  });
  it("guides a saved success to Results", () => {
    const result = developmentWorkflow(true, { ...empty, latestStatus: "succeeded", savedSettings: true });
    expect(result.step).toBe("results");
    expect(result.states.run).toBe("Complete");
    expect(result.states.results).toBe("Ready to review");
  });
  it.each(["failed", "needs_attention"])("flags saved %s results for attention", status => {
    const result = developmentWorkflow(true, { ...empty, latestStatus: status });
    expect(result.step).toBe("results");
    expect(result.states.run).toBe("Needs attention");
    expect(result.states.results).toBe("Needs attention");
  });
  it.each(["loading", "unavailable"] as const)("does not mistake %s history for no runs", history => {
    const result = developmentWorkflow(true, { ...empty, history });
    expect(result.step).toBe("results");
    expect(result.states.results).toBe(history === "loading" ? "Loading" : "Needs attention");
    expect(result.action).toMatch(history === "loading" ? /Loading/ : /Reload history/);
  });
  it("shows delivery recovery before suggesting a new run", () => {
    const result = developmentWorkflow(true, { ...empty, deliveryAvailable: false });
    expect(result.step).toBe("run");
    expect(result.states.run).toBe("Needs attention");
  });
});
