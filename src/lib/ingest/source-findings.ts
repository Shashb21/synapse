/** Durable matching of source-supported questions across production extraction runs. */
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { squashText } from "./manual-blocks";

/** Keep negation, quantities and word order. Strip only introductory question wording. */
export function sourceFindingKey(sourceId: string, quote: string, kind: string, question: string, activityName?: string): string {
  const text = squashText(question).toLowerCase().replace(/[?.!]+$/, "");
  const focus = text
    .replace(/^(?:what (?:evidence|data) (?:is|are) (?:available|there)|what (?:do we know|is known)) (?:on|about|regarding) /, "")
    .replace(/^what (?:is|are) (?:the )?/, "");
  const parts = [sourceId, squashText(quote).toLowerCase(), kind, focus || text];
  const activity = activityName && squashText(activityName).toLowerCase();
  if (activity) parts.push(activity);
  return JSON.stringify(parts);
}

function findingParts(key: string): [string, string, string, string, string?] | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return;
  }
  if (Array.isArray(parts) && (parts.length === 4 || parts.length === 5) && parts.every(part => typeof part === "string")) {
    return [parts[0], parts[1], parts[2], parts[3], parts[4]];
  }
}

/** Historical S3 keys retain the original question, so they can be read without rewriting decisions. */
export function currentSourceFindingKey(key: string): string {
  const parts = findingParts(key);
  return parts ? sourceFindingKey(...parts) : key;
}

/** Older keys omit activity identity, so keep their findings eligible for reconciliation. */
function compatibleActivities(left?: string, right?: string): boolean {
  return !left || !right || left === right;
}

/** Compare source evidence across classifications, using activity identity when both keys have it. */
export function sameSourceQuestion(left: string, right: string): boolean {
  const a = findingParts(currentSourceFindingKey(left)), b = findingParts(currentSourceFindingKey(right));
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1] && a[3] === b[3] && compatibleActivities(a[4], b[4]));
}

function groupFindings(keys: Iterable<string>, includeQuestion: boolean) {
  const groups = new Map<string, string[]>();
  for (const key of new Set(keys)) {
    const parts = findingParts(key);
    if (!parts) continue;
    const [source, quote, , question] = parts;
    const scope = JSON.stringify(includeQuestion ? [source, quote, question] : [source, quote]);
    const group = groups.get(scope);
    if (group) group.push(key);
    else groups.set(scope, [key]);
  }
  return groups;
}

/**
 * Reconcile across classification changes only when the passage identifies one
 * matching question. If both batches contain unidentified findings on the same
 * passage, their text alone cannot distinguish a paraphrase from another need.
 * Keep the recorded decision intact for human review in that case.
 */
export function reclassifiedFindings(current: Iterable<string>, prior: Iterable<string>): Map<string, string> {
  const incomingKeys = new Set(current);
  const storedKeys = new Set(prior);
  const byQuestion = groupFindings(storedKeys, true);
  const matches = new Map<string, string>();
  for (const [scope, incoming] of groupFindings(incomingKeys, true)) {
    const stored = byQuestion.get(scope) ?? [];
    for (const key of incoming) {
      if (storedKeys.has(key)) continue;
      const matching = stored.filter(priorKey => sameSourceQuestion(priorKey, key));
      if (matching.length === 1) matches.set(key, matching[0]!);
      if (matching.length > 1) {
        throw new TrustedApplicationError("This question has several recorded classifications. Review the source before retrying.", "ambiguous_source_finding", 409);
      }
    }
  }
  const incomingByPassage = groupFindings(incomingKeys, false);
  for (const [passage, stored] of groupFindings(storedKeys, false)) {
    const incoming = incomingByPassage.get(passage);
    if (!incoming) continue;
    const represented = new Set(incoming.map(key => matches.get(key) ?? key));
    const unresolved = stored.filter(key => !represented.has(key));
    const ambiguous = incoming.some(key => !storedKeys.has(key) && !matches.has(key) &&
      unresolved.some(priorKey => compatibleActivities(findingParts(key)?.[4], findingParts(priorKey)?.[4])));
    if (ambiguous) {
      throw new TrustedApplicationError(
        "A previously recorded passage has a different extraction question. Review the source and use a more specific quotation before retrying.",
        "ambiguous_source_finding", 409,
      );
    }
  }
  return matches;
}
