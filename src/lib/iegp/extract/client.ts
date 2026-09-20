import { completeJson, hasAgenticLlm } from "@/lib/llm/router";
import type { AgenticCompleteArgs, AgenticPurpose } from "@/lib/llm/agentic";
import { moduleForPurpose, providerLoginHint, type LlmModuleId } from "@/lib/llm/catalog";
import { routeForModule } from "@/lib/llm/settings";

export type JsonCompleter = (args: AgenticCompleteArgs) => Promise<unknown>;

let injected: JsonCompleter | null = null;

export function setGapExtractCompleter(fn: JsonCompleter | null) {
  injected = fn;
}

export function gapExtractLlmReady(moduleId: LlmModuleId = "gaps"): boolean {
  return Boolean(injected) || hasAgenticLlm(moduleId);
}

export function assertGapExtractLlmReady(moduleId: LlmModuleId = "gaps") {
  if (gapExtractLlmReady(moduleId)) return;
  const provider = routeForModule(moduleId).provider;
  throw new Error(
    `${providerLoginHint(provider, moduleId)} Gap extraction requires a live LLM (proposer, critic, judge).`,
  );
}

export async function completeExtractJson(args: {
  system: string;
  user: string;
  maxTokens?: number;
  purpose?: AgenticPurpose;
  module?: LlmModuleId;
}): Promise<unknown> {
  const module = args.module ?? moduleForPurpose(args.purpose);
  assertGapExtractLlmReady(module);
  const fn = injected ?? completeJson;
  return fn({ ...args, module });
}
