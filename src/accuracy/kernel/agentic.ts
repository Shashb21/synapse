import type { JsonCompletion } from "../kernel/contracts";

export type AgenticExchangeResult<T> = {
  final: T;
  exchanges: number;
  trace: string[];
};

/**
 * Default extraction depth: one propose, one checklist critic, one revise.
 * Hillclimb can raise `maxExchanges` per module eval scores.
 */
export async function runShallowAgenticCycle<T>(args: {
  maxExchanges?: number;
  proposer: (round: number, prior: T | null, critiques: string[]) => Promise<T>;
  critic: (draft: T) => Promise<{ score: number; issues: string[] }>;
  judge: (draft: T) => Promise<T>;
}): Promise<AgenticExchangeResult<T>> {
  const max = args.maxExchanges ?? 1;
  const trace: string[] = [];
  let draft = await args.proposer(0, null, []);
  trace.push("round0:proposer");
  for (let exchange = 0; exchange < max; exchange++) {
    const critique = await args.critic(draft);
    trace.push(`round${exchange + 1}:critic`);
    if (critique.issues.length === 0 && critique.score >= 0.85) break;
    draft = await args.proposer(exchange + 1, draft, critique.issues);
    trace.push(`round${exchange + 1}:reviser`);
  }
  const final = await args.judge(draft);
  trace.push("judge");
  return { final, exchanges: max, trace };
}

export async function stubAgenticLlm<T>(complete: JsonCompletion, purpose: string): Promise<T | null> {
  try {
    const { raw } = await complete({
      system: "Return JSON only.",
      user: purpose,
      purpose,
    });
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
