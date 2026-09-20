import { completeJson } from "@/lib/llm/anthropic";
import { hasAnthropicKey } from "@/lib/config";

export type JsonCompleter = (args: {
  system: string;
  user: string;
  maxTokens?: number;
}) => Promise<unknown>;

let injected: JsonCompleter | null = null;

export function setGapExtractCompleter(fn: JsonCompleter | null) {
  injected = fn;
}

export function gapExtractLlmReady(): boolean {
  return Boolean(injected) || hasAnthropicKey();
}

export function assertGapExtractLlmReady() {
  if (gapExtractLlmReady()) return;
  throw new Error(
    "ANTHROPIC_API_KEY is not set. Gap extraction requires a live LLM (proposer, critic, judge).",
  );
}

export async function completeExtractJson(args: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<unknown> {
  assertGapExtractLlmReady();
  const fn = injected ?? completeJson;
  return fn(args);
}
