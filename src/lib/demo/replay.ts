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
  /** The prompt with ids replaced by placeholders, for matching. */
  user_norm: string;
  system_norm: string;
  /** Distinct ids in the recorded prompt (system then user), in order of first appearance. */
  ids: string[];
  reply: string;
};

export type Recording = { recorded_at: string | null; calls: RecordedCall[] };

const RECORDING = recordingFile as Recording;

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

/** Word-set overlap of two prompts, 0 to 1 (1: the same words). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Maps the recorded run's ids onto this run's. Ids are paired by kind (GAP with
 * GAP, DOC with DOC) in order of first appearance, which is how the same inputs
 * produce them in both runs.
 */
export function idMapping(recorded: string[], current: string[]): Map<string, string> {
  const kind = (id: string) => id.match(/^[A-Za-z]+/)?.[0] ?? "";
  const byKind = new Map<string, string[]>();
  for (const id of current) byKind.set(kind(id), [...(byKind.get(kind(id)) ?? []), id]);
  const taken = new Map<string, number>();
  const map = new Map<string, string>();
  for (const id of recorded) {
    const k = kind(id);
    const index = taken.get(k) ?? 0;
    const next = byKind.get(k)?.[index];
    taken.set(k, index + 1);
    if (next && next !== id) map.set(id, next);
  }
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
  let best = candidates[0]!;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = candidate.user_norm === user ? 2 : similarity(candidate.user_norm, user);
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
  const current = idsIn(`${call.system}\n${call.user}`);
  return applyMapping(recorded.reply, idMapping(recorded.ids, current));
}

/** A recorded call, from one llm_calls row of the recording run. */
export function recordedCallFrom(row: { stage: string | null; purpose: string; system_prompt: string; user_prompt: string; reply: string }): RecordedCall {
  return {
    stage: row.stage,
    purpose: row.purpose,
    user_norm: normalizePrompt(row.user_prompt),
    system_norm: normalizePrompt(row.system_prompt),
    ids: idsIn(`${row.system_prompt}\n${row.user_prompt}`),
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
