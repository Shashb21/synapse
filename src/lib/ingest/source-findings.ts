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

/** The original candidate's activity name, when captured on an S3 finding. */
export function sourceFindingActivity(key: string): string | undefined {
  return findingParts(key)?.[4];
}

/** Historical S3 keys retain the original question, so they can be read without rewriting decisions. */
export function currentSourceFindingKey(key: string, fallbackActivity?: string): string {
  const parts = findingParts(key);
  if (!parts) return key;
  const [source, quote, kind, question, activity] = parts;
  return sourceFindingKey(source, quote, kind, question, activity ?? fallbackActivity);
}

type ActivityLabels = (key: string) => Iterable<string>;

/** Use words documented in the citation, excluding generic study labels and articles. */
function activityWords(label: string, quote: string): Set<string> {
  const generic = /^(?:a|an|and|for|in|of|on|the|with|study|studies|registry|registries|review|analysis|trial)$/;
  const quoted = new Set(quote.match(/[\p{L}\p{N}]+/gu));
  return new Set((label.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => quoted.has(word) && !generic.test(word)));
}

/** Distinguish cited aliases, coordinated activities, and titles merely mentioned together. */
function citedActivityRelation(quote: string, left: string, right: string): "same" | "different" | "unknown" | undefined {
  const words = (value: string) => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
  const leftName = words(left).replace(/^(?:the|an?) /, "");
  const rightName = words(right).replace(/^(?:the|an?) /, "");
  if (!leftName || !rightName) return;
  if (leftName === rightName) return "same";
  // Replace the longer complete title first so a nested title cannot represent both.
  const titles = [leftName, rightName].sort((a, b) => b.length - a.length);
  const title = new RegExp(`(^| )(${titles.join("|")})(?= |$)`, "g");
  const sentences = quote.split(/[;.!?]/u).map(sentence => words(sentence).replace(
    title, (_match, space: string, name: string) => space + (name === leftName ? "<a>" : "<b>"),
  ));
  const evidence = sentences.join(" ");
  if (!evidence.includes("<a>") || !evidence.includes("<b>")) return;
  // Give alias evidence priority over a conjunction within the rename itself.
  const alias = /(<[ab]>) (?:was |is |has been )?(?:renamed(?: to| as| and is now called)?|(?:now |formerly |also )?(?:called|known as)) (?:the )?(?!\1)<[ab]>/;
  if (sentences.some(sentence => alias.test(sentence))) return "same";
  const coordination = /(<[ab]>) and (?:the )?(?!\1)<[ab]> (?:both|each|(?:are|were) (?:two )?(?:separate|distinct|different))\b/;
  const contrast = /(<[ab]>) (?:.*? )?(?:whereas|versus) (?:the )?(?!\1)<[ab]>/;
  if (sentences.some(sentence => coordination.test(sentence) || contrast.test(sentence))) return "different";
  return "unknown";
}

function compareActivities(quote: string, left?: string, right?: string): "same" | "different" | "unknown" {
  if (left === right) return "same";
  if (!left || !right) return "unknown";
  const cited = citedActivityRelation(quote, left, right);
  if (cited === "same" || cited === "different") return cited;
  const a = activityWords(left, quote), b = activityWords(right, quote);
  if ([...a].some(word => !b.has(word)) && [...b].some(word => !a.has(word))) return "different";
  if (cited === "unknown") return "unknown";
  return [...a].some(word => b.has(word)) ? "same" : "unknown";
}

/** Match exact names first, then positive evidence in the source and immutable review alternatives. */
export function matchingSourceQuestions(key: string, candidates: Iterable<string>, labels?: ActivityLabels): string[] {
  const current = findingParts(currentSourceFindingKey(key));
  if (!current) return [];
  const exact: string[] = [], supported: string[] = [];
  for (const candidate of candidates) {
    const other = findingParts(currentSourceFindingKey(candidate));
    if (!other || other[0] !== current[0] || other[1] !== current[1] || other[3] !== current[3]) continue;
    if (current[4] === other[4]) {
      exact.push(candidate);
      continue;
    }
    const relation = compareActivities(current[1], current[4], other[4]);
    if (relation === "different") continue;
    if (!current[4] || relation === "same" ||
        [...labels?.(candidate) ?? []].some(label => compareActivities(current[1], current[4], label.toLowerCase()) === "same")) {
      supported.push(candidate);
    }
  }
  return exact.length ? exact : supported;
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
export function reclassifiedFindings(current: Iterable<string>, prior: Iterable<string>, labels?: ActivityLabels): Map<string, string> {
  const incomingKeys = new Set(current);
  const storedKeys = new Set(prior);
  const byQuestion = groupFindings(storedKeys, true);
  const matches = new Map<string, string>();
  for (const [scope, incoming] of groupFindings(incomingKeys, true)) {
    const stored = byQuestion.get(scope) ?? [];
    const claimedNames = new Map<string, Set<string>>();
    for (const key of incoming) {
      const matching = storedKeys.has(key) ? [key] : matchingSourceQuestions(key, stored, labels);
      if (matching.length === 1) {
        const previous = matching[0]!;
        if (previous !== key) matches.set(key, previous);
        const name = sourceFindingActivity(key);
        if (name && !sourceFindingActivity(previous)) {
          throw new TrustedApplicationError("The recorded finding has no identifiable activity. Review the original passage before retrying.", "ambiguous_source_finding", 409);
        }
        if (name) {
          const names = claimedNames.get(previous) ?? new Set<string>();
          names.add(name);
          claimedNames.set(previous, names);
          const quote = findingParts(key)![1];
          if (names.size > 1 && [...names].some(other => other !== name && citedActivityRelation(quote, name, other) !== "same")) {
            throw new TrustedApplicationError("Several activities could refer to the same recorded finding. Review the original passage before retrying.", "ambiguous_source_finding", 409);
          }
        }
      }
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
    const ambiguous = incoming.some(key => {
      if (storedKeys.has(key) || matches.has(key)) return false;
      const [, quote, , question, activity] = findingParts(key)!;
      return stored.some(previous => {
        const parts = findingParts(previous)!;
        if (represented.has(previous) && question !== parts[3]) return false;
        return compareActivities(quote, activity, parts[4]) !== "different";
      });
    });
    if (ambiguous) {
      throw new TrustedApplicationError(
        "A previously recorded passage has an unresolved activity or extraction question. Review the source and use a more specific quotation before retrying.",
        "ambiguous_source_finding", 409,
      );
    }
  }
  return matches;
}
