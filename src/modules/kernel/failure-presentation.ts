/** Read-only projections for stored exception diagnostics, shared by API and page readers. */
export const HISTORICAL_FAILURE_MESSAGE = "This run could not finish. Review the workspace and AI settings before running this task again.";

/** Project error-bearing diagnostic objects, retaining ordinary scientific values and scores. */
export function projectFailureDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectFailureDiagnostics);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  // Exception payloads may contain arbitrary sibling fields (SQL, parameters, replies).
  // Only the stable call identifier is permitted alongside the fixed explanation.
  if (("error" in record && record.error !== null && typeof record.error !== "number" && typeof record.error !== "boolean") || record.status === "error") {
    const id = record.llm_call_id;
    return { error: HISTORICAL_FAILURE_MESSAGE, ...(typeof id === "string" && /^llm_[a-zA-Z0-9_-]+$/.test(id) ? { llm_call_id: id } : {}) };
  }
  return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, projectFailureDiagnostics(nested)]));
}

/** Suppress a failed step's free-form detail as well as its expanded exception payload. */
export function projectRunSteps<T extends { data?: unknown; detail?: string | null }>(steps: T[], failedRun = false): T[] {
  return steps.map(step => {
    const data = step.data && typeof step.data === "object" && !Array.isArray(step.data) ? step.data as Record<string, unknown> : null;
    // Older Accuracy failures recorded the exception only in detail, with a call id or no data.
    const legacyFailure = failedRun && Boolean(step.detail) && (!data || Object.keys(data).every(key => key === "llm_call_id"));
    const failed = legacyFailure || Boolean(data && (("error" in data && data.error !== null && typeof data.error !== "number" && typeof data.error !== "boolean") || data.status === "error"));
    return { ...step, ...(failed ? { detail: null } : {}), data: projectFailureDiagnostics(legacyFailure ? { error: true, llm_call_id: data?.llm_call_id, status: "error" } : step.data) };
  });
}
