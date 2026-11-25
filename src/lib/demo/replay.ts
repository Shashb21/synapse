import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { TrustedApplicationError } from "@/modules/kernel/stage-errors";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { VELMARA_DEMO_FIXTURE } from "./replay-provider";
import recordingFile from "./recording-replay.json";
import historicalRecording from "./recording.json";
import { mapReplayIds, mutableReference, purposeReference, WHOLE_ID } from "./replay-identifiers";

export type ReplayRequest = {
  stage: StageId | null;
  purpose: string;
  system: string;
  user: string;
};

type RecordedCall = {
  stage: StageId;
  purpose_hash: string;
  system_hash: string;
  user_hash: string;
  /** Distinct mutable application IDs in purpose, then user order. */
  ids: string[];
  reply?: string;
  /** An unchanged reply in the original fictional recording, pinned by its digest. */
  historical_reply?: { index: number; sha256: string };
};

type ExportedCall = RecordedCall & { reply: string };

export type Recording = {
  version: 3;
  fixture: typeof VELMARA_DEMO_FIXTURE;
  recorded_at: string | null;
  capture?: { recording_id: string; started_at: string; ended_at: string };
  calls: RecordedCall[];
};

const RECORDING = recordingFile as Recording;

const kindOf = (id: string) => id.match(/^[A-Za-z]+/)?.[0];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const literal = (text: string) => digest(JSON.stringify(["literal", text]));

function identity(request: ReplayRequest & { stage: StageId }): Omit<RecordedCall, "stage" | "reply"> {
  const ids: string[] = [];
  const slots = new Map<string, number>();
  function slot(id: string): [string, number] {
    let position = slots.get(id);
    if (position === undefined) {
      position = ids.length;
      ids.push(id);
      slots.set(id, position);
    }
    return [kindOf(id)!, position];
  }
  const purpose = purposeReference(request.stage, request.purpose);
  const purpose_hash = purpose ? digest(JSON.stringify(["purpose", purpose[0], slot(purpose[1])])) : literal(request.purpose);
  let user_hash = literal(request.user);
  if (request.stage === "S3" && purpose?.[0] === "tactic-proposer:") {
    const source = /^Source: (SRC-\d{3,})\n\n/.exec(request.user);
    if (source) user_hash = digest(JSON.stringify(["source", slot(source[1]!), request.user.slice(source[0].length)]));
  } else {
    let user: unknown;
    try {
      user = JSON.parse(request.user);
    } catch {
      // The S2 proposer and other plain-text requests keep all their text.
    }
    if (user && typeof user === "object" && JSON.stringify(user) === request.user) {
      const references: [(string | number)[], string, [string, number], string][] = [];
      const content = mapReplayIds(request.stage, "request", user, (value, path) => {
        const reference = mutableReference(value);
        if (!reference) return value;
        references.push([path, reference.prefix, slot(reference.id), reference.suffix]);
        return null;
      });
      // The path and slot identify each reference, while the remaining JSON is exact.
      if (references.length) user_hash = digest(JSON.stringify(["json", content, references]));
    }
  }
  return { purpose_hash, system_hash: literal(request.system), user_hash, ids };
}

function mappedReply(stage: StageId, raw: string, replacements: Map<string, string>): unknown {
  return mapReplayIds(stage, "reply", extractJsonObject(raw), value => {
    const reference = mutableReference(value);
    if (!reference) return value;
    const next = replacements.get(reference.id);
    if (!next) throw new Error("A recorded reply refers to an application ID outside its request.");
    return reference.prefix + next + reference.suffix;
  });
}

export function recordedCallKey(call: Pick<RecordedCall, "stage" | "purpose_hash" | "system_hash" | "user_hash">): string {
  return [call.stage, call.purpose_hash, call.system_hash, call.user_hash].join(":");
}

export class DemoReplayMissError extends TrustedApplicationError {
  constructor() {
    super(
      'The recorded Velmara demo has no answer for this step. Use “Reset demo” and follow the walkthrough with the Velmara files. If the step still fails, ask your Synapse administrator to update the recording.',
      "demo_replay_miss",
      409,
    );
    this.name = "DemoReplayMissError";
  }
}

function requestIdsMatch(recorded: unknown, current: string[]): recorded is string[] {
  return Array.isArray(recorded) && recorded.length === current.length && new Set(recorded).size === recorded.length &&
    recorded.every((id, i) => typeof id === "string" && WHOLE_ID.test(id) && kindOf(id) === kindOf(current[i]!));
}

export function replayReply(call: ReplayRequest, recording: Recording = RECORDING): string {
  if (!call?.stage || !STAGE_IDS.includes(call.stage) || typeof call.purpose !== "string" || !call.purpose.trim() ||
      typeof call.system !== "string" || typeof call.user !== "string" || recording?.version !== 3 ||
      recording.fixture !== VELMARA_DEMO_FIXTURE || !Array.isArray(recording.calls)) {
    throw new DemoReplayMissError();
  }
  const current = identity({ ...call, stage: call.stage });
  const key = recordedCallKey({ stage: call.stage, ...current });
  const matches = recording.calls.filter(recorded => recorded && recordedCallKey(recorded) === key);
  const recorded = matches.length === 1 ? matches[0] : null;
  if (!recorded || !requestIdsMatch(recorded.ids, current.ids)) throw new DemoReplayMissError();
  const reference = recorded.historical_reply;
  const historical = reference && Number.isInteger(reference.index) ? historicalRecording.calls[reference.index] : null;
  const rawReply = reference
    ? historical?.stage === recorded.stage && digest(historical.reply) === reference.sha256 && recorded.reply === undefined
      ? historical.reply : null
    : recorded.reply;
  if (typeof rawReply !== "string") throw new DemoReplayMissError();
  const replacements = new Map(recorded.ids.map((id, i) => [id, current.ids[i]!]));
  try {
    return JSON.stringify(mappedReply(call.stage, rawReply, replacements));
  } catch {
    throw new DemoReplayMissError();
  }
}

export function recordedCallFrom(row: { stage: StageId; purpose: string; system_prompt: string; user_prompt: string; reply: string }): ExportedCall {
  const fingerprints = identity({ stage: row.stage, purpose: row.purpose, system: row.system_prompt, user: row.user_prompt });
  mappedReply(row.stage, row.reply, new Map(fingerprints.ids.map(id => [id, id])));
  return {
    stage: row.stage,
    ...fingerprints,
    reply: row.reply,
  };
}

/** Compare the parsed replies in one request's ID space using the same rebinding as replay. */
export function sameRecordedReply(first: ExportedCall, second: ExportedCall): boolean {
  if (recordedCallKey(first) !== recordedCallKey(second) || !requestIdsMatch(first.ids, second.ids)) return false;
  const replacements = new Map(first.ids.map((id, i) => [id, second.ids[i]!]));
  return isDeepStrictEqual(mappedReply(first.stage, first.reply, replacements), extractJsonObject(second.reply));
}

/** The playback pause can be disabled for local testing. */
export function replayDelayMs(): number {
  const fixed = Number(process.env.SYNAPSE_DEMO_REPLAY_DELAY_MS);
  if (Number.isFinite(fixed) && fixed >= 0 && process.env.SYNAPSE_DEMO_REPLAY_DELAY_MS !== undefined) return fixed;
  return 1200 + Math.floor(Math.random() * 1600);
}
