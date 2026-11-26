import { extractJsonObject } from "@/lib/llm/anthropic";
import { STAGE_IDS, type StageId } from "@/modules/kernel/contracts";
import { WORKED_EXAMPLES_FRAMING } from "@/modules/kernel/decision-examples";
import { recordedCallFrom, recordedCallKey, sameRecordedReply, type Recording } from "./replay";
import { isDemoRecordingId, isDemoReplayProvider, VELMARA_DEMO_FIXTURE } from "./replay-provider";

type RecordingInterval = { workspaceId: string; recordingId: string; startedAt: string; endedAt: string };

export function recordingInterval(workspaceId: string, recordingId: string, start: string, end: string): RecordingInterval {
  function utcInstant(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
    const normalized = new Date(value).toISOString();
    return normalized === (value.includes(".") ? value : value.replace(/Z$/, ".000Z")) ? normalized : null;
  }
  const startedAt = utcInstant(start);
  const endedAt = utcInstant(end);
  if (!workspaceId.trim() || !isDemoRecordingId(recordingId) || !startedAt || !endedAt || startedAt >= endedAt) {
    throw new Error("Select one workspace, its recording UUID and an ordered start and end time in UTC.");
  }
  return { workspaceId, recordingId, startedAt, endedAt };
}

export type DemoRecordingRow = {
  stage: string | null;
  purpose: string;
  system_prompt: string;
  user_prompt: string;
  reply: string | null;
  provider_id: string;
  demo_fixture: string | null;
  demo_recording_id: string | null;
  workspace_id: string | null;
  created_at: Date | string;
  status: string;
  attempt: number;
};

/** Build a fixture from an ordered trace export of the approved fictional recording run. */
export function buildDemoRecording(rows: DemoRecordingRow[], interval: RecordingInterval, recordedAt: string): Recording {
  const calls = new Map<string, ReturnType<typeof recordedCallFrom>>();
  const start = Date.parse(interval.startedAt);
  const end = Date.parse(interval.endedAt);
  for (const row of rows) {
    const at = new Date(row.created_at).getTime();
    if (row.workspace_id !== interval.workspaceId || row.demo_recording_id !== interval.recordingId || !(at >= start && at < end) ||
        row.demo_fixture !== VELMARA_DEMO_FIXTURE || isDemoReplayProvider(row.provider_id) ||
        !STAGE_IDS.includes(row.stage as StageId) || !row.purpose) {
      throw new Error("The selected recording interval includes a call outside the Velmara recording run.");
    }
    if (row.status !== "ok" || row.reply === null) throw new Error("The recording run includes a failed call. Use a complete clean walkthrough.");
    if (`${row.system_prompt}\n${row.user_prompt}`.includes(WORKED_EXAMPLES_FRAMING)) {
      throw new Error("The recording run includes worked examples. Reset the Velmara demo workspace and record it again.");
    }
    if (row.attempt !== 1) {
      throw new Error("The recording run needed a JSON repair retry. Record a clean walkthrough with a usable first reply to each request.");
    }
    try {
      extractJsonObject(row.reply);
    } catch {
      throw new Error("The recording run includes an invalid JSON reply. Record a clean walkthrough with a usable first reply to each request.");
    }
    const call = recordedCallFrom({ ...row, stage: row.stage as StageId, reply: row.reply });
    const key = recordedCallKey(call);
    const previous = calls.get(key);
    if (!previous) {
      calls.set(key, call);
    } else if (!sameRecordedReply(previous, call)) {
      throw new Error("The recording run includes conflicting replies for the same Velmara request. Record a walkthrough with consistent replies.");
    }
  }
  if (!calls.size) throw new Error("The recording run contains no exportable Velmara calls.");
  return {
    version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: recordedAt,
    capture: { recording_id: interval.recordingId, started_at: interval.startedAt, ended_at: interval.endedAt },
    calls: [...calls.values()],
  };
}
