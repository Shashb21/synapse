import { ProviderError, type ProviderErrorKind } from "@/modules/llm/provider-error";
import type { StageId } from "./contracts";

/**
 * What a customer is told when an AI step fails (KAN-68). Stage errors carry
 * the owner's remedy (switch a route in /admin/control, raise Max tokens) and
 * provider errors name the account's problem; customers never see the owner
 * console, so they get plain wording that says whether anything was saved and
 * to ask their administrator. The owner keeps the technical message.
 */

/** A model that never returned a complete answer for every row a stage asked about. */
export class IncompleteAnswerError extends Error {
  constructor(
    message: string,
    /** Noun for the rows, e.g. "mapping", "score". */
    readonly what: string,
  ) {
    super(message);
    this.name = "IncompleteAnswerError";
  }
}

const ASK_ADMIN = "Try again; if it keeps failing, contact your Synapse administrator.";

const PROVIDER_CUSTOMER_MESSAGE: Record<ProviderErrorKind, string> = {
  billing:
    "The AI provider isn't available right now (the platform's AI account needs attention). Your work is saved; try again later or contact your Synapse administrator.",
  auth: "The AI provider isn't available right now (the platform's AI account needs attention). Your work is saved; try again later or contact your Synapse administrator.",
  rate_limit: "The AI provider is busy right now. Your work is saved; wait a minute and try again.",
  unavailable: "The AI provider isn't responding right now. Your work is saved; try again in a few minutes.",
  bad_request: `The AI provider couldn't handle this request. Your work is saved. ${ASK_ADMIN}`,
  other: `The AI provider couldn't handle this request. Your work is saved. ${ASK_ADMIN}`,
};

/** How each AI step is named to a customer. */
const STEP_NAME: Partial<Record<StageId, string>> = {
  S1: "Reading the source",
  S2: "Gap extraction",
  S3: "Tactic extraction",
  S4: "Mapping",
  S6: "The split proposal",
  S8: "Prioritization",
  S9: "Ideation",
  S10: "The timeline",
};

/**
 * Text that only makes sense in the owner console: routes, keys, token budgets,
 * raw HTTP, and a ProviderError's message folded into another error (S1 records
 * a failed file's reason, and ingest repeats it).
 */
const ADMIN_ONLY =
  /\/admin\/control|switch (?:its|the \S+) route|AI & routing|max_tokens|Max tokens|_API_KEY|API key|HTTP \d{3}|did not return valid JSON|"type"\s*:\s*"error"|credit balance|rejected the request/i;

// Which stage an error came out of, without touching the error itself.
const stageOfError = new WeakMap<object, StageId>();

/** Records the stage an error was thrown from (runStage does this for every failure). */
export function tagStageError(error: unknown, stage: StageId): void {
  if (error && typeof error === "object" && !stageOfError.has(error)) stageOfError.set(error, stage);
}

export function stageOf(error: unknown): StageId | null {
  return error && typeof error === "object" ? (stageOfError.get(error) ?? null) : null;
}

/** True when the message is meant for the owner and must be reworded for a customer. */
export function isAdminOnlyError(error: unknown): boolean {
  if (error instanceof ProviderError || error instanceof IncompleteAnswerError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return ADMIN_ONLY.test(message);
}

/**
 * The customer's message for an error, or null when its own message is already
 * fine to show (validation errors, "Nothing to ingest." and the like).
 */
const DAILY_QUOTA_CUSTOMER_MESSAGE =
  "The AI has reached its limit for today. Your work is saved; try again tomorrow, or contact your Synapse administrator.";

export function customerErrorMessage(error: unknown): string | null {
  if (error instanceof ProviderError) {
    // A daily cap won't lift in a minute (KAN-70).
    if (error.info.daily_quota) return DAILY_QUOTA_CUSTOMER_MESSAGE;
    return PROVIDER_CUSTOMER_MESSAGE[error.kind];
  }
  if (!isAdminOnlyError(error)) return null;
  const stage = stageOf(error);
  const step = (stage && STEP_NAME[stage]) ?? "The AI step";
  if (error instanceof IncompleteAnswerError) {
    return `${step} couldn't finish because the AI didn't return a complete answer. Nothing was saved. ${ASK_ADMIN}`;
  }
  return `${step} couldn't finish because of a problem with the AI. Nothing was saved. ${ASK_ADMIN}`;
}
