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
