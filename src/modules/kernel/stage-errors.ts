/** Public error wording and stage metadata; unknown exceptions never reach users. */
import { ProviderError, type ProviderErrorKind } from "@/modules/llm/provider-error";
import type { StageId } from "./contracts";

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
    "The AI provider isn't available right now (the platform's AI account needs attention). Try again later or contact your Synapse administrator.",
  auth: "The AI provider isn't available right now (the platform's AI account needs attention). Try again later or contact your Synapse administrator.",
  rate_limit: "The AI provider is busy right now. Wait a minute and try again.",
  unavailable: "The AI provider isn't responding right now. Try again in a few minutes.",
  bad_request: `The AI provider couldn't handle this request. ${ASK_ADMIN}`,
  other: `The AI provider couldn't handle this request. ${ASK_ADMIN}`,
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

// Which stage an error came out of, without touching the error itself.
const stageOfError = new WeakMap<object, StageId>();

/** Records the stage an error was thrown from (runStage does this for every failure). */
export function tagStageError(error: unknown, stage: StageId): void {
  if (error && typeof error === "object" && !stageOfError.has(error)) stageOfError.set(error, stage);
}

export function stageOf(error: unknown): StageId | null {
  return error && typeof error === "object" ? (stageOfError.get(error) ?? null) : null;
}

/** An application-owned message. Only construct with fixed copy and safe domain values. */
export class TrustedApplicationError extends Error {
  constructor(message: string, readonly code = "invalid_request", readonly status = 400) {
    super(message);
    this.name = "TrustedApplicationError";
  }
}

/** Unknown failures require translation for every audience, including owners. */
export function isAdminOnlyError(error: unknown): boolean {
  return !(error instanceof TrustedApplicationError);
}

/** Safe wording shared by the API and historical failure summaries. */
export function customerErrorMessage(error: unknown): string {
  if (error instanceof TrustedApplicationError) return error.message;
  if (error instanceof ProviderError) {
    if (error.info.daily_quota) return "The AI has reached its limit for today. Try again tomorrow, or contact your Synapse administrator.";
    return PROVIDER_CUSTOMER_MESSAGE[error.kind];
  }
  const stage = stageOf(error);
  const step = (stage && STEP_NAME[stage]) ?? "This action";
  if (error instanceof IncompleteAnswerError) {
    return `${step} couldn't finish because the AI didn't return a complete answer. Check the current results before trying again. ${ASK_ADMIN}`;
  }
  return `${step} couldn't finish. Check the current state before trying again. If this continues, contact your Synapse administrator.`;
}

/** Owner recovery uses known classifications, never provider messages or exception text. */
export function ownerErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    if (error.info.daily_quota) return "The AI has reached its daily limit. Try again tomorrow, or choose another connected model in AI & routing.";
    if (error.kind === "auth") return "The AI account connection needs attention. Check the provider connection in AI & routing, then try again.";
    if (error.kind === "billing") return "The AI account needs credit or billing attention. Check billing with the provider, then try again.";
  }
  return customerErrorMessage(error);
}
