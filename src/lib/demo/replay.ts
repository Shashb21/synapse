import { createHash } from "node:crypto";
import recordingFile from "./recording.json";

/**
 * Replays the recorded demo run (KAN-138). In a client-demo workspace every AI
 * call is answered from src/lib/demo/recording.json instead of a model: the
 * recorded call for the same stage and purpose whose prompt is most like this
 * one, with the recorded run's ids mapped onto this run's ids (they differ on
 * every reset). Timeline estimates are month offsets from the plan's anchor, so
 * they need no date changes.
 */

export type RecordedCall = {
  stage: string | null;
  purpose: string;
  /** Fingerprint of the prompt with ids replaced by placeholders: an exact match. */
  user_hash: string;
  /** The prompt's distinct words, for the closest match when nothing is exact. */
  user_words: string;
  /** Distinct ids in the recorded prompt (system then user), in order of first appearance. */
  ids: string[];
  /** For each id (same order), the text that follows where the prompt defines it: what it is. */
  anchors?: string[];
  reply: string;
};

export type Recording = { recorded_at: string | null; calls: RecordedCall[] };

const RECORDING = recordingFile as unknown as Recording;

/**
 * Ids the app mints: `GAP-001` style (allocateId) and `DOC_20261016T120000_0001_ab12`
 * style (newId), plus content-hashed file ids. Content tokens such as "VEL-301"
 * or "EGFR-mutant" are left alone.
 */
const ID_RE =
  /\b(?:(?:GAP|NEED|SRC|TAC|COV|RES|OBJ|BLK|EXP|ACT|IDEA|PROP|SUG)-\d{3,}|[A-Za-z]{1,8}_\d{8}T\d{6}_\d{4}_[a-z0-9]{4}|FILE-[a-f0-9]{10})\b/g;

/** Distinct ids in `text`, in order of first appearance. */
export function idsIn(text: string): string[] {
  return [...new Set(text.match(ID_RE) ?? [])];
}

/** `text` with every id replaced by a typed placeholder, so two runs' prompts compare equal. */
export function normalizePrompt(text: string): string {
  return text.replace(ID_RE, (id) => `⟨${id.match(/^[A-Za-z]+/)?.[0] ?? "id"}⟩`).replace(/\s+/g, " ").trim();
}

/** A stage's purpose without the ids it carries, e.g. "gap-proposer:⟨DOC⟩". */
export function purposeKey(purpose: string): string {
  return normalizePrompt(purpose);
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9⟨⟩]+/).filter((w) => w.length > 2));
}

/** A normalized prompt's fingerprint and distinct words, as the recording keeps them. */
export function promptSignature(normalized: string): { user_hash: string; user_words: string } {
  return { user_hash: createHash("sha256").update(normalized).digest("hex").slice(0, 32), user_words: [...words(normalized)].join(" ") };
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** Word-set overlap of two prompts, 0 to 1 (1: the same words). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  return overlap(words(a), words(b));
}

/**
 * What each id is, read from the prompt: the text that follows where the prompt
 * defines it (`"id":"GAP-004","name":"Caregiver burden…`), else its first use.
 * Two runs list the same gaps in different orders; the anchor still matches.
 */
export function anchorsFor(text: string, ids: string[]): string[] {
  return ids.map((id) => {
    const at = text.indexOf(`"id":"${id}"`);
    const start = at >= 0 ? at + `"id":"${id}"`.length : text.indexOf(id) + id.length;
    // Only what describes this id: stop where its object (or the next id's entry) begins.
    const window = text.slice(start, start + 160);
    const end = window.search(/[{}]|"id":/);
    return normalizePrompt(end >= 0 ? window.slice(0, end) : window);
  });
}

const kindOf = (id: string) => id.match(/^[A-Za-z]+/)?.[0] ?? "";

/**
 * Maps the recorded run's ids onto this run's. An id pairs first with the
 * current id of the same kind that the prompt describes the same way (its
 * anchor), so a different listing order cannot swap two gaps; ids left over
 * pair by kind in order of first appearance.
 */
export function idMapping(
  recorded: string[],
  current: string[],
  recordedAnchors?: string[],
  currentAnchors?: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  if (recordedAnchors && currentAnchors) {
    const byAnchor = new Map<string, string[]>();
    current.forEach((id, i) => {
      const key = `${kindOf(id)}|${currentAnchors[i]}`;
      byAnchor.set(key, [...(byAnchor.get(key) ?? []), id]);
    });
    recorded.forEach((id, i) => {
      const hits = byAnchor.get(`${kindOf(id)}|${recordedAnchors[i]}`);
      if (hits?.length === 1 && !used.has(hits[0]!)) {
        map.set(id, hits[0]!);
        used.add(hits[0]!);
      }
    });
  }
  const left = new Map<string, string[]>();
  for (const id of current) if (!used.has(id)) left.set(kindOf(id), [...(left.get(kindOf(id)) ?? []), id]);
  for (const id of recorded) {
    if (map.has(id)) continue;
    const next = left.get(kindOf(id))?.shift();
    if (next) map.set(id, next);
  }
  for (const [from, to] of map) if (from === to) map.delete(from);
  return map;
}

function applyMapping(reply: string, map: Map<string, string>): string {
  if (!map.size) return reply;
  return reply.replace(ID_RE, (id) => map.get(id) ?? id);
}

export class DemoReplayMissError extends Error {
  constructor(purpose: string) {
    super(
      `This step was not part of the recorded client demo (${purpose}), so demo mode has no answer for it. Reset the demo and follow the demo files, or turn demo mode off for live AI.`,
    );
  }
}

/** The recorded call that answers this one, or null when the recording has none for its stage and purpose. */
export function findRecordedCall(
  call: { stage: string | null; purpose: string; system: string; user: string },
  recording: Recording = RECORDING,
): RecordedCall | null {
  const key = purposeKey(call.purpose);
  const candidates = recording.calls.filter((c) => c.stage === call.stage && purposeKey(c.purpose) === key);
  if (!candidates.length) return null;
  const user = normalizePrompt(call.user);
  const { user_hash } = promptSignature(user);
  const mine = words(user);
  let best = candidates[0]!;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = candidate.user_hash === user_hash ? 2 : overlap(new Set(candidate.user_words.split(" ")), mine);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** This call's reply from the recording, with its ids made to fit this run. */
export function replayReply(
  call: { stage: string | null; purpose: string; system: string; user: string },
  recording: Recording = RECORDING,
): string {
  const recorded = findRecordedCall(call, recording);
  if (!recorded) throw new DemoReplayMissError(call.purpose);
  const prompt = `${call.system}\n${call.user}`;
  const current = idsIn(prompt);
  return applyMapping(recorded.reply, idMapping(recorded.ids, current, recorded.anchors, anchorsFor(prompt, current)));
}

/** A recorded call, from one llm_calls row of the recording run. */
export function recordedCallFrom(row: { stage: string | null; purpose: string; system_prompt: string; user_prompt: string; reply: string }): RecordedCall {
  return {
    stage: row.stage,
    purpose: row.purpose,
    ...promptSignature(normalizePrompt(row.user_prompt)),
    ids: idsIn(`${row.system_prompt}\n${row.user_prompt}`),
    anchors: anchorsFor(`${row.system_prompt}\n${row.user_prompt}`, idsIn(`${row.system_prompt}\n${row.user_prompt}`)),
    reply: row.reply,
  };
}

/** How long a replayed step "thinks", so the demo looks like the product: 1.2 to 2.8 s, or SYNAPSE_DEMO_REPLAY_DELAY_MS. */
export function replayDelayMs(): number {
  const fixed = Number(process.env.SYNAPSE_DEMO_REPLAY_DELAY_MS);
  if (Number.isFinite(fixed) && fixed >= 0 && process.env.SYNAPSE_DEMO_REPLAY_DELAY_MS !== undefined) return fixed;
  return 1200 + Math.floor(Math.random() * 1600);
}

/** Whether a recording has been made yet (the demo cannot run without one). */
export function hasRecording(recording: Recording = RECORDING): boolean {
  return recording.calls.length > 0;
}
