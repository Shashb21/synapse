import type { ModuleContext } from "./contracts";
import { canPrompt } from "./routing";
import { NoRouteError } from "@/modules/llm/provider";
import { AiDisabledError } from "./ai-switch";

/**
 * Judgement belongs to a model. These helpers are what every stage uses to hold
 * that line: refuse to run without a connected LLM, and never fill in a row the
 * model left out.
 */

/**
 * Vitest and Playwright only. The stub swaps the model for fixed, labelled test
 * output; it is refused in a production build so a stray env var can never turn
 * rule-based stand-ins into real decisions.
 */
export function isTestStub(): boolean {
  if (process.env.SYNAPSE_TEST_STUB_LLM !== "1") return false;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SYNAPSE_TEST_STUB_LLM is set in a production build. Unset it; stages need a real LLM.");
  }
  return true;
}

/** Throws unless the stage can prompt a model (or is running under the test stub). */
export function requireLlm(ctx: Pick<ModuleContext, "route"> & { ai?: boolean }, what: string): void {
  // The admin switch wins over everything, the test stub included.
  if (ctx.ai === false) throw new AiDisabledError(what);
  if (isTestStub()) return;
  if (!canPrompt(ctx.route)) {
    throw new NoRouteError(
      ctx.route.reason ??
        `${what} needs a connected LLM. Log in at /control (Grok, Claude, or another provider) and run it again.`,
    );
  }
}

/** Re-asks for rows a model left out before the stage gives up. */
export const COMPLETION_ATTEMPTS = 3;

/**
 * Asks the model once per attempt for the rows still missing, and keeps what
 * each answer completes. `ask` must leave out any row that is incomplete or
 * invalid so it is asked for again. A row the model never completes fails the
 * stage: nothing is filled in on its behalf.
 */
export async function completeAll<T>(args: {
  ids: string[];
  /** Noun for the error, e.g. "score", "review", "mapping". */
  what: string;
  ask: (missing: string[], attempt: number) => Promise<Map<string, T>>;
  describe?: (id: string) => string;
  /** What to tell the user to do next. */
  remedy?: string;
}): Promise<Map<string, T>> {
  const done = new Map<string, T>();
  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
    const missing = args.ids.filter((id) => !done.has(id));
    if (missing.length === 0) break;
    const answer = await args.ask(missing, attempt);
    for (const id of missing) {
      const row = answer.get(id);
      if (row !== undefined) done.set(id, row);
    }
  }
  const unanswered = args.ids.filter((id) => !done.has(id));
  if (unanswered.length > 0) {
    const describe = args.describe ?? ((id: string) => id);
    throw new Error(
      `The model did not return a complete ${args.what} for ${unanswered.map(describe).join(", ")} after ${COMPLETION_ATTEMPTS} attempts. Nothing was saved; ${
        args.remedy ?? "run the stage again or switch its route in /control."
      }`,
    );
  }
  return done;
}
