import { AsyncLocalStorage } from "node:async_hooks";
import { promptVariantInstruction, type PromptVersionId } from "./prompt-versions";

const store = new AsyncLocalStorage<PromptVersionId | null>();

/** Runs work under a hillclimb prompt variant (eval / sweep only). */
export function withPromptVariant<T>(version: PromptVersionId, fn: () => Promise<T>): Promise<T> {
  return store.run(version, fn);
}

export function activePromptVersion(): PromptVersionId {
  return store.getStore() ?? "v1.0-baseline";
}

/** Extra system instructions for the active prompt version, if any. */
export function augmentSystemPrompt(base: string): string {
  const extra = promptVariantInstruction(activePromptVersion());
  if (!extra) return base;
  return `${base}\n\n${extra}`;
}

/** Evaluation scope overrides the approved instruction without mutating the live pointer. */
const revisions = new AsyncLocalStorage<{ id: string | null; instruction: string }>();
export function withPromptRevision<T>(revision: { id: string | null; instruction: string }, fn: () => Promise<T>): Promise<T> {
  return revisions.run(revision, fn);
}
export function scopedPromptRevision() { return revisions.getStore(); }
/** Bind once per stage run so every proposer, critic and judge uses the same instruction. */
export function revisionCompletion(complete: import('./contracts').JsonCompletion, instruction: string): import('./contracts').JsonCompletion {
  return args => complete({ ...args, system: instruction ? `${args.system}\n\nApproved stage instructions:\n${instruction}` : args.system });
}
