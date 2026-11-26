import { describe, expect, it } from "vitest";
import { buildDemoRecording, recordingInterval, type DemoRecordingRow } from "@/lib/demo/recording-export";
import { replayReply } from "@/lib/demo/replay";
import { VELMARA_DEMO_FIXTURE } from "@/lib/demo/replay-provider";
import { WORKED_EXAMPLES_FRAMING } from "@/modules/kernel/decision-examples";

const run = "b1d1d892-4f6f-46de-8ab0-4cab8f9eeef2";
const workspace = "velmara-workspace";
const interval = recordingInterval(workspace, run, "2026-11-25T08:00:00Z", "2026-11-25T09:00:00Z");
const row: DemoRecordingRow = {
  workspace_id: workspace, demo_recording_id: run, created_at: interval.startedAt, status: "ok",
  stage: "S8", purpose: "priority-suggester", system_prompt: "Review this gap.",
  user_prompt: '{"gaps":[{"id":"GAP-001","name":"Fictional example"}]}',
  reply: '{"gaps":[{"band":"low","gap_id":"GAP-001"}]}', provider_id: "approved-recording-provider", demo_fixture: VELMARA_DEMO_FIXTURE, attempt: 1,
};
const at = "2026-11-25T09:00:00.000Z";
const ask = {
  stage: "S8" as const, purpose: row.purpose, system: row.system_prompt,
  user: row.user_prompt.replace("GAP-001", "GAP-049"),
};

describe("KAN-263 recording export", () => {
  it("retains distinct exact requests and deduplicates equal replies after exact ID rebinding", () => {
    const system = "Review this other fictional example.";
    const fixture = buildDemoRecording([
      row,
      { ...row, system_prompt: system, reply: '{"gaps":[{"band":"defer","gap_id":"GAP-001"}]}' },
      { ...row, user_prompt: ask.user, reply: '{"gaps":[{"gap_id":"GAP-049","band":"low"}]}' },
    ], interval, at);
    expect(fixture).toMatchObject({ version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: at, capture: { recording_id: run, started_at: interval.startedAt, ended_at: interval.endedAt } });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[0]?.reply).toBe(row.reply);
    expect(JSON.parse(replayReply(ask, fixture))).toEqual({ gaps: [{ band: "low", gap_id: "GAP-049" }] });
    expect(JSON.parse(replayReply({ ...ask, system }, fixture))).toEqual({ gaps: [{ band: "defer", gap_id: "GAP-049" }] });
    expect(() => replayReply({ ...ask, system: "A changed system prompt" }, fixture)).toThrow(/recorded Velmara demo/);
    expect(JSON.stringify(fixture)).not.toContain(row.user_prompt);
  });

  it.each([
    { reply: '{"gaps":[{"band":"high","gap_id":"GAP-001"}]}' },
    { user_prompt: ask.user, reply: '{"gaps":[{"band":"high","gap_id":"GAP-049"}]}' },
    { user_prompt: ask.user, reply: '{"gaps":[{"band":"low","gap_id":"GAP-049","reason":"GAP-049"}]}' },
  ])("refuses conflicting replies for an identical canonical request (%j)", (change) => {
    expect(() => buildDemoRecording([row, { ...row, ...change }], interval, at)).toThrow(/conflicting replies/);
  });

  it("keeps literal IDs in free text exact when comparing replies", () => {
    const original = { ...row, reply: '{"gaps":[{"band":"low","gap_id":"GAP-001","reason":"GAP-001"}]}' };
    const changed = { ...row, user_prompt: ask.user, reply: '{"gaps":[{"band":"low","gap_id":"GAP-049","reason":"GAP-049"}]}' };
    expect(() => buildDemoRecording([original, changed], interval, at)).toThrow(/conflicting replies/);
  });

  it.each([
    { demo_fixture: null },
    { demo_fixture: "unrelated-demo" },
    { demo_recording_id: null },
    { workspace_id: "customer-workspace" },
    { provider_id: "demo-replay" },
    { reply: '{"gaps":[{"gap_id":"GAP-094"}]}' },
    { stage: null },
    { user_prompt: WORKED_EXAMPLES_FRAMING },
    { system_prompt: WORKED_EXAMPLES_FRAMING },
  ])("refuses a contaminated recording (%j)", (change) => {
    expect(() => buildDemoRecording([row, { ...row, ...change }], interval, at)).toThrow();
  });

  it("refuses an empty or unparseable export", () => {
    expect(() => buildDemoRecording([], interval, at)).toThrow(/no exportable/);
    expect(() => buildDemoRecording([{ ...row, reply: "bad JSON" }], interval, at)).toThrow(/invalid JSON/);
  });

  it("refuses a recording where only the changed-system JSON retry has a usable reply", () => {
    expect(() => buildDemoRecording([
      { ...row, reply: "not JSON" },
      { ...row, attempt: 2, system_prompt: `${row.system_prompt}\n\nYour previous reply was not valid JSON (bad). Reply with exactly one valid JSON object and nothing else: escape every double quote inside strings, and put a comma between array elements.` },
    ], interval, at)).toThrow(/invalid JSON/);
    expect(() => buildDemoRecording([{ ...row, attempt: 2 }], interval, at)).toThrow(/JSON repair retry/);
  });

  it("refuses mixed run provenance even when both rows are valid fictional completions", () => {
    const first = { ...row, demo_recording_id: "b1d1d892-4f6f-46de-8ab0-4cab8f9eeef2" };
    const second = { ...row, demo_recording_id: "3d0b1f0f-e816-4f34-8ec4-6f4b73f4a5d1" };
    expect(() => buildDemoRecording([first, second], interval, at)).toThrow(/recording interval/);
  });

  it("accepts the start boundary and excludes the end and earlier rows", () => {
    expect(buildDemoRecording([row], interval, at).calls).toHaveLength(1);
    for (const created_at of [interval.endedAt, "2026-11-25T07:59:59.999Z"]) {
      expect(() => buildDemoRecording([{ ...row, created_at }], interval, at)).toThrow(/recording interval/);
    }
    expect(() => buildDemoRecording([{ ...row, status: "error", reply: null }], interval, at)).toThrow(/failed call/);
  });

  it.each([
    ["not-a-uuid", "2026-11-25T08:00:00Z", "2026-11-25T09:00:00Z"],
    [run, "2026-11-25T08:00:00+00:00", "2026-11-25T09:00:00Z"],
    [run, "2026-02-29T08:00:00Z", "2026-03-01T09:00:00Z"],
    [run, "2026-11-25T09:00:00Z", "2026-11-25T08:00:00Z"],
    [run, "2026-11-25T09:00:00Z", "2026-11-25T09:00:00Z"],
    [run, "2026-11-25T08:00:00Z", ""],
  ])("rejects a missing or invalid window (%s %s %s)", (id, start, end) => {
    expect(() => recordingInterval(workspace, id, start, end)).toThrow(/ordered start and end time/);
  });
});
