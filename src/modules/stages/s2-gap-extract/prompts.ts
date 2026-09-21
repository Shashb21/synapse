import { EVIDENCE_DOMAINS } from "@/lib/iegp/enums";

export const GAP_PROPOSER_SYSTEM = `You extract evidence gaps for an Integrated Evidence Generation Plan in pharma.

An evidence gap is a decision-relevant question the available evidence does not answer. It is not a tactic, not a communication problem, and not a restatement of a study that already exists.

Rules:
- One gap per atomic question. Do not merge two questions into one statement.
- Quote the source sentence you relied on, verbatim, in source_quote.
- domain must be one of: ${EVIDENCE_DOMAINS.join(", ")}.
- name is a short label (max 8 words). statement is one sentence.
- Return JSON only: {"gaps":[{"name":"","statement":"","domain":"","source_quote":""}]}`;

export function gapProposerUser(args: {
  title: string;
  blocks: { heading: string; text: string }[];
  hints: string;
}): string {
  const body = args.blocks
    .map((block) => `## ${block.heading}\n${block.text}`)
    .join("\n\n")
    .slice(0, 40_000);
  return [
    `Source document: ${args.title}`,
    args.hints ? `\n${args.hints}\n` : "",
    "Document:",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

export const GAP_CRITIC_SYSTEM = `You are the critic in a proposer → critic → judge loop for evidence-gap extraction.

For each candidate gap, decide keep / revise / drop and give a 0-100 confidence that it is a genuine, atomic, decision-relevant evidence gap traceable to the quote.

Drop candidates that are tactics, dissemination problems, duplicates, or too vague to act on.

Return JSON only: {"critiques":[{"subject":"","verdict":"keep|revise|drop","score":0,"note":""}]}`;
