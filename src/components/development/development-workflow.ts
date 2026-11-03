/** Derive the next useful action from saved documents and execution history. */
export type WorkflowStep = "documents" | "settings" | "run" | "results";
export type WorkflowFacts = {
  history: "loading" | "ready" | "unavailable";
  latestStatus: string | null;
  savedSettings: boolean;
  deliveryAvailable: boolean;
};
export const workflowSteps: { id: WorkflowStep; label: string }[] = [
  { id: "documents", label: "Documents" },
  { id: "settings", label: "Test settings" },
  { id: "run", label: "Run" },
  { id: "results", label: "Results" },
];

/** Recommend a step without treating visited controls or defaults as saved work. */
export function developmentWorkflow(hasSources: boolean, facts: WorkflowFacts) {
  const states: Record<WorkflowStep, string> = {
    documents: hasSources ? "Complete" : "Not started",
    settings: facts.savedSettings ? "Complete" : "Not started",
    run: "Not started",
    results: "Not started",
  };
  let step: WorkflowStep = hasSources ? "settings" : "documents";
  let action = hasSources ? "Review test settings, then go to Run. Settings are saved with an execution." : "Add and save a source document to begin.";
  if (facts.history !== "ready") {
    states.results = facts.history === "loading" ? "Loading" : "Needs attention";
    if (hasSources) step = "results";
    action = facts.history === "loading" ? "Loading saved execution history…" : "Reload history in Results before starting another run; saved runs could not be checked.";
  } else if (["queued", "running"].includes(facts.latestStatus ?? "")) {
    step = "run";
    states.run = "In progress";
    action = "A run is in progress. Monitor its status before starting another.";
  } else if (facts.latestStatus) {
    step = "results";
    const attention = facts.latestStatus !== "succeeded";
    states.run = attention ? "Needs attention" : "Complete";
    states.results = attention ? "Needs attention" : "Ready to review";
    action = attention ? "Inspect the saved run and its errors before retrying. A fresh run may incur charges." : "Review saved outputs, evaluate them, or compare executions in Results.";
  } else if (hasSources && !facts.deliveryAvailable) {
    step = "run";
    states.run = "Needs attention";
    action = "Check execution delivery in Run before starting generation.";
  }
  return { step, states, action };
}
