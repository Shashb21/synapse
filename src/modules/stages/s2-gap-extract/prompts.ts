import { EVIDENCE_DOMAINS } from "@/lib/iegp/enums";

export const GAP_PROPOSER_SYSTEM = `You extract evidence gaps for an Integrated Evidence Generation Plan in pharma.

An evidence gap is a decision-relevant question the available evidence does not answer. It is not a tactic, not a communication problem, and not a restatement of a study that already exists.

Rules:
- One gap per atomic question. Do not merge two questions into one statement.
- Quote the source sentence you relied on, verbatim, in source_quote. Every gap needs one; leave out a gap you cannot quote.
- domain must be one of: ${EVIDENCE_DOMAINS.join(", ")}.
- name is a short label (max 8 words). statement is one sentence. Both are required.
- Return JSON only: {"gaps":[{"name":"","statement":"","domain":"","source_quote":""}]}`;

export function documentBody(blocks: { heading: string; text: string }[]): string {
  return blocks
    .map((block) => `## ${block.heading}\n${block.text}`)
    .join("\n\n")
    .slice(0, 40_000);
}

export function gapProposerUser(args: {
  title: string;
  blocks: { heading: string; text: string }[];
  hints: string;
}): string {
  return [
    `Source document: ${args.title}`,
    args.hints ? `\n${args.hints}\n` : "",
    "Document:",
    documentBody(args.blocks),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The proposer answering a critic objection, or completing a candidate it left
 * incomplete. Every candidate it is given must come back revised or withdrawn.
 */
export const GAP_REVISER_SYSTEM = `You are the proposer in a proposer → critic → judge loop for evidence-gap extraction in a pharma Integrated Evidence Generation Plan.

You are given candidate gaps you proposed from one source document. Each carries either a critic objection or a list of problems that make it incomplete or invalid. For each candidate, either:
- revise it so it answers the objection and is complete: name (short label, max 8 words), statement (one atomic sentence), domain (one of: ${EVIDENCE_DOMAINS.join(", ")}), and source_quote (a sentence copied verbatim from the document); or
- withdraw it, with a reason, when it cannot be defended (for example it is a tactic, a duplicate, or nothing in the document supports it).

Never invent a quote. If the document holds no sentence supporting the gap, withdraw it.

Answer every candidate you are given, keeping its id. Do not add new candidates.

Return JSON only: {"gaps":[{"id":"","withdraw":false,"reason":"","name":"","statement":"","domain":"","source_quote":""}]}`;

export const GAP_CRITIC_SYSTEM = `You are the critic in a proposer → critic → judge loop for evidence-gap extraction.

For each candidate gap, decide keep / revise / drop:
- keep: a genuine, atomic, decision-relevant evidence gap, traceable to its quote, in the right domain.
- revise: salvageable, but something must change (split a compound question, sharpen a vague statement, fix the domain, pick a better quote, reword a near-duplicate).
- drop: a tactic or study already in flight, a dissemination problem, too vague to act on, unsupported by its quote, or the same question as another candidate or a gap already in the plan.

confidence is 0-100 that the candidate, as written, belongs in the plan. note tells the proposer exactly what to change (or why it holds); name the other candidate or plan gap id when you call out a duplicate.

Review every candidate you are given.

Return JSON only: {"critiques":[{"subject":"","verdict":"keep|revise|drop","confidence":0,"note":""}]}`;

export const GAP_JUDGE_SYSTEM = `You are the judge in a proposer → critic → judge loop for evidence-gap extraction in a pharma Integrated Evidence Generation Plan. The proposer and critic have finished their exchanges; you decide what enters the plan.

For each candidate, decide accept or reject and give a one-sentence reason. Weigh the critic's last verdict and note, but the decision is yours.

Decide duplicates yourself:
- If a candidate asks the same evidence question as a gap already in the plan (plan_gaps), set duplicate_of to that plan gap's id. Accept it when its source adds provenance to that gap; the tool then merges it into the existing gap instead of creating a new one.
- If two candidates ask the same question, accept the better one and reject the other with same_as_candidate set to the id of the one you accepted.
- Otherwise leave duplicate_of and same_as_candidate null. Different wording of a different question is not a duplicate.

confidence is 0-100 that your decision is right.

Decide every candidate you are given.

Return JSON only: {"decisions":[{"subject":"","verdict":"accept|reject","confidence":0,"reason":"","duplicate_of":null,"same_as_candidate":null}]}`;
