import { completeJson, hasAgenticLlm } from "@/lib/llm/agentic";
import type { AgenticCompleteArgs, AgenticPurpose } from "@/lib/llm/agentic";

export type JsonCompleter = (args: AgenticCompleteArgs) => Promise<unknown>;

let injected: JsonCompleter | null = null;

export function setGapExtractCompleter(fn: JsonCompleter | null) {
  injected = fn;
}

export function gapExtractLlmReady(): boolean {
  return Boolean(injected) || hasAgenticLlm();
}

export function assertGapExtractLlmReady() {
  if (gapExtractLlmReady()) return;
  throw new Error(
    "No Claude Code OAuth session or ANTHROPIC_API_KEY. Gap extraction requires a live LLM (proposer, critic, judge). Run `claude /login` or set CLAUDE_CODE_OAUTH_TOKEN.",
  );
}

export async function completeExtractJson(args: {
  system: string;
  user: string;
  maxTokens?: number;
  purpose?: AgenticPurpose;
}): Promise<unknown> {
  assertGapExtractLlmReady();
  const fn = injected ?? completeJson;
  return fn(args);
}
