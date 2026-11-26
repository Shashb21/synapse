import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDemoRecording, recordingInterval, type DemoRecordingRow } from "@/lib/demo/recording-export";
import { DemoReplayMissError, recordedCallFrom, replayReply, type Recording, type ReplayRequest } from "@/lib/demo/replay";
import { VELMARA_DEMO_FIXTURE } from "@/lib/demo/replay-provider";
import { buildClientDemoWorkspace } from "@/lib/iegp/blank";
import * as store from "@/lib/iegp/store";
import * as database from "@/modules/kernel/db";
import type { ModuleContext } from "@/modules/kernel/contracts";
import * as parsed from "@/modules/stages/s1-parse/module";
import type { ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";
import * as suggestions from "@/modules/stages/s3-tactic-extract/suggestions";
import * as relationships from "@/lib/iegp/relationship-change";
import { gapExtractModule } from "@/modules/stages/s2-gap-extract/module";
import { tacticExtractModule } from "@/modules/stages/s3-tactic-extract/module";
import * as placements from "@/modules/stages/s8-prioritization/module";

const workspaceId = "fictional-demo";
const recordingId = "b1d1d892-4f6f-46de-8ab0-4cab8f9eeef2";
const interval = recordingInterval(workspaceId, recordingId, "2026-11-25T00:00:00Z", "2026-11-25T00:10:00Z");
const quote = "The evidence note cites [block_id=SRC-021-B03].";
const authoredLine = "## Customer heading [block_id=SRC-021-B03]";
const hint = "Confirm the wording in the source.";
const state = buildClientDemoWorkspace();
const stageModules = { S2: gapExtractModule, S3: tacticExtractModule };
type Stage = keyof typeof stageModules;

function documents(reset: boolean): ParsedDocumentRecord[] {
  const sourceIds = reset ? ["SRC-121", "SRC-122"] : ["SRC-021", "SRC-022"];
  const ids = reset
    ? ["DOC_20261201T130000_1001_3dk4", "DOC_20261201T130000_1002_4de5"]
    : ["DOC_20261125T000000_0001_ab12", "DOC_20261125T000000_0002_bc23"];
  const blocks = [
    [
      { heading: "Original [block_id=SRC-021-B01]", text: `${authoredLine}\n${"x".repeat(40_700)}` },
      { heading: "First repeated passage", text: quote },
      { heading: "Second repeated passage", text: quote },
    ],
    [{ heading: "Independent document", text: quote }],
  ];
  return ids.map((id, i) => ({
    id, source_id: sourceIds[i]!, file_id: `fiction-${i + 1}`,
    parser: "llm", parser_version: "2.0.0", parsed_at: "2026-11-25T00:00:00Z", duration_ms: 0,
    blocks: blocks[i]!.map((block, j) => ({ ...block, id: `${sourceIds[i]}-B0${j + 1}`, source_id: sourceIds[i]!, location: String(j + 1) })),
    quality: { blocks: blocks[i]!.length, characters: 0, avg_block_chars: 0, empty_blocks: 0, need_cue_blocks: 0, tactic_cue_blocks: 0, warnings: [] },
  }));
}

function context(stage: Stage, docs: ParsedDocumentRecord[], mode: "record" | "replay", complete: ModuleContext["complete"]): ModuleContext {
  return {
    workspace_id: workspaceId, actor: { name: "Presenter", function: "medical_affairs" }, role: "medical_affairs", ai: true,
    run: { id: "scripted-run", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] },
    route: {
      stage, provider_id: mode === "record" ? "scripted" : "demo-replay", provider_label: mode, model: mode,
      auth: mode === "record" ? "api_key" : "none", connected: true,
      params: { temperature: 0, max_tokens: 16000 }, fallbacks: [], degraded: false, reason: null,
      demo: { workspace_id: workspaceId, fixture: VELMARA_DEMO_FIXTURE, ...(mode === "record" ? { mode, recording_id: recordingId } : { mode }) },
    },
    replay: { evaluation: false, input: {}, facts: { documents: docs, state: { ...state, blocks: docs.flatMap(doc => doc.blocks) } }, module_id: "scripted", module_version: "1", prompt_version: "v1.0-baseline" },
    complete,
  };
}

type Request = Parameters<ModuleContext["complete"]>[0];
type Candidate = { id: string; subject: string; name: string; source_quote: string; block_id: string | null };

function answer(stage: Stage, request: Request) {
  const gap = stage === "S2";
  const field = gap ? "gaps" : "tactics";
  const finding = (name: string, block_id?: string) => ({
    name, source_quote: quote, block_id,
    ...(gap ? { statement: `What does ${name} show?`, domain: "comparative_effectiveness" }
      : { type: "registry", status: "ongoing", evidence_question: `What does ${name} show?` }),
  });
  if (!request.user.startsWith("{")) {
    if (request.user.includes("[block_id=block-3]")) return { [field]: [
      finding("Second passage", "block-3"),
      { ...finding("First passage", "block-2"), domain: "", type: "" },
      finding("Unresolved passage", "block-1"),
    ] };
    if (request.user.includes("Independent document")) return { [field]: [finding("Other source", "block-1")] };
    return { [field]: [] };
  }
  const body = JSON.parse(request.user);
  if (request.role === "proposer" || request.role === "reviser") {
    expect(body.document).toContain("Second repeated passage [block_id=block-3]");
    expect(body.document).not.toContain(authoredLine);
    const [row] = gap ? body.candidates : body.rows;
    if (request.role === "proposer") {
      expect(row.id).toMatch(/-LT?002-W2$/);
      if (!gap) {
        expect(row.previous.block_id).toBe("block-2");
        expect(row.previous).not.toHaveProperty("id");
        if (!body.note) return { tactics: [{ id: row.id, ...finding("First passage", "block-2"), type: "", reason: authoredLine }] };
        expect(row.previous.reason).toBe(authoredLine);
      }
      return { [field]: [{ id: row.id, ...finding("First passage", "block-2") }] };
    }
    expect(row.id).toMatch(/-LT?001-W2$/);
    expect(gap ? row.block_id : row.previous.block_id).toBe("block-3");
    return { [field]: [{ id: row.id, ...finding("Second passage") }] };
  }
  const candidates: Candidate[] = gap || request.role === "critic" ? body.candidates : body.decide;
  if (!gap) {
    expect(candidates.map(({ block_id }) => block_id)).toEqual(request.role === "critic"
      ? ["block-3", "block-2", "block-1", "block-1"]
      : ["block-3", "block-2", "block-1"]);
  }
  expect(candidates.every(row => row.source_quote === quote)).toBe(true);
  if (request.role === "critic") return {
    [gap ? "critiques" : "reviews"]: candidates.map(row => ({
      [gap ? "subject" : "id"]: gap ? row.subject : row.id,
      verdict: String(body.exchange).startsWith("1 ") && row.name === "Second passage" ? "revise" : "keep",
      confidence: 90, note: hint,
    })),
  };
  return { decisions: candidates.map(row => ({
    [gap ? "subject" : "id"]: gap ? row.subject : row.id,
    verdict: "accept", match: "new", target_tactic_id: null, confidence: 90, reason: hint,
  })) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("KAN-263 extraction capture and reset replay", () => {
  it.each(["S2", "S3"] as const)("%s replays all extraction roles and supplies real block IDs to persistence", async stage => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    const insert = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(database, "db").mockReturnValue({
      insert: () => ({ values: insert }),
      execute: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.spyOn(parsed, "lockCurrentExtractionDocuments").mockResolvedValue(undefined);
    vi.spyOn(relationships, "lockRelationships").mockResolvedValue(undefined);
    vi.spyOn(store, "loadState").mockResolvedValue(state);
    vi.spyOn(suggestions, "recordedTacticEvidence").mockResolvedValue(new Map());
    vi.spyOn(placements, "validatedPlacementGapIds").mockResolvedValue([]);
    const commit = vi.spyOn(store, "commitExtractedRecords").mockResolvedValue({
      need_ids: [], gap_ids: [], merged_gap_ids: [], gap_id_by_row: {}, suggestion_id_by_row: {},
      tactic_ids: [], skipped_tactic_ids: [], flagged_gap_ids: [],
    });
    const extractor = stageModules[stage];
    const rows: DemoRecordingRow[] = [];
    const script: ModuleContext["complete"] = async request => {
      const result = answer(stage, request);
      rows.push({
        stage, purpose: request.purpose, system_prompt: request.system, user_prompt: request.user, reply: JSON.stringify(result),
        workspace_id: workspaceId, demo_fixture: VELMARA_DEMO_FIXTURE, demo_recording_id: recordingId,
        provider_id: "scripted", created_at: "2026-11-25T00:05:00Z", status: "ok", attempt: 1,
      });
      return result;
    };
    await extractor.run({ dry_run: false }, context(stage, documents(false), "record", script));
    const fixture = buildDemoRecording(rows, interval, "2026-11-25T00:11:00Z");
    const purposes = rows.map(call => call.purpose);
    expect(purposes.filter(purpose => purpose.endsWith("-critic"))).toHaveLength(3);
    const judge = stage === "S3" ? "tactic-judge" : "gap-judge";
    expect(purposes.some(purpose => purpose.startsWith(judge))).toBe(true);
    expect(rows[0]!.user_prompt).toContain("Original [block_id=SRC-021-B01] [block_id=block-1]");
    expect(rows[0]!.user_prompt).toContain(authoredLine);
    expect(() => replayReply({
      stage, purpose: rows[0]!.purpose, system: rows[0]!.system_prompt, user: rows[0]!.user_prompt,
    })).toThrow(DemoReplayMissError);

    insert.mockClear();
    commit.mockClear();
    const reset = documents(true);
    const replayRequests: ReplayRequest[] = [];
    const play: ModuleContext["complete"] = async request => {
      replayRequests.push({ stage, ...request });
      return JSON.parse(replayReply({ stage, ...request }, fixture));
    };
    const replayed = await extractor.run({ dry_run: false }, context(stage, reset, "replay", play));
    expect(replayRequests).toHaveLength(rows.length);
    const content = (user: string) => user.replace(/^Source: SRC-\d+\n\n/, "");
    expect(replayRequests.filter(({ user }) => !user.startsWith("{")).map(({ user }) => content(user)))
      .toEqual(rows.filter(({ user_prompt }) => !user_prompt.startsWith("{")).map(({ user_prompt }) => content(user_prompt)));
    if (stage === "S3") {
      const fixes = replayRequests.filter(({ purpose }) => purpose.startsWith("tactic-proposer-fix:"));
      expect(fixes).toHaveLength(2);
      expect(JSON.parse(fixes[1]!.user)).toMatchObject({
        rows: [{ id: `${reset[0]!.id}-LT002-W2`, previous: { reason: authoredLine, block_id: "block-2" } }],
      });
      expect(JSON.parse(fixes[1]!.user).rows[0].previous).not.toHaveProperty("id");
    }
    const kind = stage === "S2" ? "L" : "LT";
    const expected = [
      [`${reset[0]!.id}-${kind}001-W2`, "SRC-121-B03"],
      [`${reset[0]!.id}-${kind}002-W2`, "SRC-121-B02"],
      [`${reset[1]!.id}-${kind}001`, "SRC-122-B01"],
    ];
    expect(replayed.output.accepted.map(row => [row.id, row.block_id ?? null])).toEqual(expected);
    const persisted = insert.mock.calls[0]?.[0] as { block_id: string | null; verdict: string }[];
    expect(persisted.filter(row => row.verdict === "accept").map(row => row.block_id)).toEqual(expected.map(([, block]) => block));
    expect(persisted).toContainEqual(expect.objectContaining({ block_id: null, verdict: "reject" }));
    expect(commit.mock.calls.flatMap(([args]) => stage === "S2"
      ? args.needs.map(row => [row.id, row.provenance?.block_id])
      : args.tactics.map(row => [row.id, row.block_id]))).toEqual(expected);

    const changed = documents(true);
    changed[0]!.blocks[0]!.text = changed[0]!.blocks[0]!.text.replace(authoredLine, authoredLine.replace("SRC-021", "SRC-121"));
    await expect(extractor.run({ dry_run: false }, context(stage, changed, "replay", play))).rejects.toMatchObject({ code: "demo_replay_miss" });
    const critic = replayRequests.find(request => request.purpose.endsWith("-critic"))!;
    expect(() => replayReply({ ...critic, user: critic.user.replace(quote, quote.replace("SRC-021", "SRC-121")) }, fixture))
      .toThrow(DemoReplayMissError);
  });

  it.each(["S2", "S3"] as const)("%s binds only the exact window candidates supplied in declared fields", stage => {
    const [original] = documents(false);
    const [reset] = documents(true);
    const kind = stage === "S2" ? "L" : "LT";
    const originalId = `${original!.id}-${kind}014-W12`;
    const currentId = `${reset!.id}-${kind}014-W12`;
    const request = (documentId: string, candidateId: string): ReplayRequest => ({
      stage, purpose: stage === "S2" ? `gap-reviser:${documentId}` : `tactic-proposer-revise:${documentId}`,
      system: "Return the supplied candidate.", user: JSON.stringify(stage === "S2"
        ? { candidates: [{ id: candidateId, source_quote: originalId }] }
        : { rows: [{ id: candidateId, previous: { source_quote: originalId } }] }),
    });
    const reply = (id: string) => JSON.stringify({ [stage === "S2" ? "gaps" : "tactics"]: [{ id, source_quote: originalId }] });
    const first = request(original!.id, originalId);
    const capture = (id: string) => recordedCallFrom({ stage, purpose: first.purpose, system_prompt: first.system, user_prompt: first.user, reply: reply(id) });
    const call = capture(originalId);
    const fixture: Recording = { version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: null, calls: [call] };
    const current = request(reset!.id, currentId);
    expect(replayReply(current, fixture)).toBe(reply(currentId));
    expect(() => replayReply(request(reset!.id, currentId.replace("-W12", "-W13")), fixture)).toThrow(DemoReplayMissError);
    expect(() => replayReply({ ...current, user: current.user.replace(originalId, currentId) }, fixture)).toThrow(DemoReplayMissError);
    for (const outside of [
      originalId.replace("-W12", "-W13"), originalId.replace("014", "015"),
      originalId.replace(`-${kind}`, stage === "S2" ? "-LT" : "-L"), currentId,
      originalId.replace("-W12", ""), originalId.replace("014-W12", "015"), original!.id,
    ]) {
      expect(() => capture(outside)).toThrow(/outside its request/);
      expect(() => replayReply(current, { ...fixture, calls: [{ ...call, reply: reply(outside) }] })).toThrow(DemoReplayMissError);
    }
  });

  it.each(["S2", "S3"] as const)("%s accepts supplied first-window candidates and existing plan targets in a mixed-window request", stage => {
    const gap = stage === "S2";
    const kind = gap ? "L" : "LT";
    const field = gap ? "subject" : "id";
    const ask = (reset: boolean) => {
      const [doc] = documents(reset);
      const late = `${doc!.id}-${kind}014-W12`;
      const first = `${doc!.id}-${kind}011`;
      const target = `${gap ? "GAP" : "TAC"}-${reset ? "023" : "009"}`;
      const candidates = [{ [field]: late }, { [field]: first }];
      return {
        late, first, target,
        request: {
          stage, purpose: gap ? "gap-judge" : "tactic-judge", system: "Assess both candidates.",
          user: JSON.stringify(gap
            ? { candidates, plan_gaps: [{ id: target }] }
            : { decide: candidates, batch: candidates, library: [{ id: target }] }),
        } satisfies ReplayRequest,
      };
    };
    const response = ({ late, first, target }: ReturnType<typeof ask>) => JSON.stringify({
      decisions: gap
        ? [{ subject: late, same_as_candidate: first }, { subject: first, match_gap_id: target, duplicate_of: target }]
        : [{ id: late, duplicate_of: first }, { id: first, target_tactic_id: target, duplicate_of: target }],
    });
    const original = ask(false);
    const current = ask(true);
    const capture = (reply: string) => recordedCallFrom({
      stage, purpose: original.request.purpose, system_prompt: original.request.system, user_prompt: original.request.user, reply,
    });
    const call = capture(response(original));
    const fixture: Recording = { version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: null, calls: [call] };
    expect(replayReply(current.request, fixture)).toBe(response(current));
    const reply = response(original).replace(original.first, original.first.replace("011", "017"));
    expect(() => capture(reply)).toThrow(/extraction candidate outside its request/);
    expect(() => replayReply(current.request, { ...fixture, calls: [{ ...call, reply }] })).toThrow(DemoReplayMissError);
  });

  it.each(["S2", "S3"] as const)("%s binds the full candidate IDs when a critic sees only first-window candidates", stage => {
    const gap = stage === "S2";
    const key = gap ? "subject" : "id";
    const kind = gap ? "L" : "LT";
    const first = documents(false)[0]!.id;
    const reset = documents(true)[0]!.id;
    const ask = (doc: string, ordinals: string[]): ReplayRequest => ({
      stage, purpose: gap ? "gap-critic" : "tactic-critic", system: "Review the candidates.",
      user: JSON.stringify({ candidates: ordinals.map(ordinal => ({ [key]: `${doc}-${kind}${ordinal}` })) }),
    });
    const reply = (doc: string, ordinals: string[]) => JSON.stringify({
      [gap ? "critiques" : "reviews"]: ordinals.map(ordinal => ({ [key]: `${doc}-${kind}${ordinal}`, verdict: "keep" })),
    });
    const request = ask(first, ["001", "003"]);
    const capture = (text: string) => recordedCallFrom({
      stage, purpose: request.purpose, system_prompt: request.system, user_prompt: request.user, reply: text,
    });
    const captured = capture(reply(first, ["003", "001"]));
    const fixture: Recording = { version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: null, calls: [captured] };
    const current = ask(reset, ["001", "003"]);
    expect(replayReply(current, fixture)).toBe(reply(reset, ["003", "001"]));
    expect(() => replayReply(ask(reset, ["003", "001"]), fixture)).toThrow(DemoReplayMissError);
    for (const ordinals of [["009", "001"], ["003", "009"], ["001-W2"]]) {
      const forged = reply(first, ordinals);
      expect(() => capture(forged)).toThrow(/extraction candidate outside its request/);
      expect(() => replayReply(current, { ...fixture, calls: [{ ...captured, reply: forged }] })).toThrow(DemoReplayMissError);
    }
  });

  it.each(["S2", "S3"] as const)("%s keeps the historical first-window proposer binding without an enumerated candidate list", stage => {
    const gap = stage === "S2";
    const kind = gap ? "L" : "LT";
    const original = documents(false)[0]!;
    const reset = documents(true)[0]!;
    const ask = (doc: ParsedDocumentRecord): ReplayRequest => ({
      stage, purpose: `${gap ? "gap" : "tactic"}-proposer:${doc.id}`, system: "Propose a finding.",
      user: gap ? quote : `Source: ${doc.source_id}\n\n${quote}`,
    });
    const reply = (doc: ParsedDocumentRecord, suffix = "") => JSON.stringify({
      [gap ? "gaps" : "tactics"]: [{ id: `${doc.id}-${kind}001${suffix}`, source_quote: quote }],
    });
    const first = ask(original);
    const capture = (text: string) => recordedCallFrom({
      stage, purpose: first.purpose, system_prompt: first.system, user_prompt: first.user, reply: text,
    });
    const call = capture(reply(original));
    const fixture: Recording = { version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: null, calls: [call] };
    expect(replayReply(ask(reset), fixture)).toBe(reply(reset));
    expect(() => capture(reply(original, "-W2"))).toThrow(/extraction candidate outside its request/);
    expect(() => replayReply(ask(reset), { ...fixture, calls: [{ ...call, reply: reply(original, "-W2") }] })).toThrow(DemoReplayMissError);
  });
});
