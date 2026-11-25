import { describe, expect, it } from "vitest";
import { DemoReplayMissError, recordedCallFrom, replayReply, type Recording, type ReplayRequest } from "@/lib/demo/replay";
import { VELMARA_DEMO_FIXTURE } from "@/lib/demo/replay-provider";
import { clientDemoFileFor } from "@/lib/demo/client-files";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import { DEMO_PACK, demoSourceById } from "@/lib/iegp/demo-pack";

const DOC_A = "DOC_20261016T101500_0001_ab12";
const DOC_B = "DOC_20261118T093000_0042_zz99";
const request: ReplayRequest = {
  stage: "S2",
  purpose: `gap-reviser:${DOC_A}`,
  system: "You propose evidence gaps.",
  user: JSON.stringify({
    candidates: [{ id: `${DOC_A}-L001`, subject: `${DOC_A}-L001`, source_quote: "Payer interviews report study TAC-001." }],
    plan_gaps: [{ id: "GAP-001", name: "Primary burden" }, { id: "GAP-002", name: "Comparator" }],
  }),
};
const call = recordedCallFrom({
  stage: "S2",
  purpose: request.purpose,
  system_prompt: request.system,
  user_prompt: request.user,
  reply: JSON.stringify({ gaps: [{ id: `${DOC_A}-L001`, statement: "Economic burden of recurrence", source_quote: "Payer interviews report study TAC-001." }] }),
});
const recording = { version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: null, calls: [call] } satisfies Recording;

describe("KAN-263 exact fixture replay", () => {
  it("rebinds S9 proposal slots across two resets while preserving the same text in a quote", () => {
    const literal = "The written source refers to GAP-001:proposal:1.";
    function ask(gap: string): ReplayRequest {
      return { stage: "S9", purpose: "ideation-proposer", system: "Use the supplied slots.",
        user: JSON.stringify({ gaps: [{ id: gap, proposal_slots: [`${gap}:proposal:1`], statement: literal }] }) };
    }
    const first = ask("GAP-001");
    const entry = recordedCallFrom({ stage: "S9", purpose: first.purpose, system_prompt: first.system, user_prompt: first.user,
      reply: '{"tactics":[{"id":"GAP-001:proposal:1","gap_id":"GAP-001","rationale":"The written source refers to GAP-001:proposal:1."}]}' });
    const fixture = { ...recording, calls: [entry] };
    for (const gap of ["GAP-043", "GAP-105"]) {
      const current = ask(gap);
      expect(JSON.parse(replayReply(current, fixture))).toEqual({ tactics: [{ id: `${gap}:proposal:1`, gap_id: gap, rationale: literal }] });
      expect(() => replayReply({ ...current, user: current.user.replace(`${gap}:proposal:1`, `${gap}:proposal:2`) }, fixture)).toThrow(DemoReplayMissError);
    }
  });

  it("rebinds a timeline expansion and object dependency across two resets while keeping the reason literal", () => {
    const reason = "The text cites ACT-TAC-001.";
    const ids = ["EXP_20261019T080538_0008_8qr6", "EXP_20261125T120000_4321_abcd", "EXP_20261201T120000_98765_3dk4"];
    function ask(expansion: string, parent: string): ReplayRequest {
      return { stage: "S10", purpose: "timeline-estimates", system: "Use the named activities.",
        user: JSON.stringify({ activities: [{ id: `ACT-EXP-${expansion}`, depends_on: [{ id: `ACT-${parent}`, reason }] }],
          other_activities: [{ id: `ACT-${parent}` }] }) };
    }
    const first = ask(ids[0]!, "TAC-001");
    const entry = recordedCallFrom({ stage: "S10", purpose: first.purpose, system_prompt: first.system, user_prompt: first.user,
      reply: JSON.stringify({ activities: [{ id: `ACT-EXP-${ids[0]}`, depends_on: [{ id: "ACT-TAC-001", reason }] }] }) });
    const fixture = { ...recording, calls: [entry] };
    for (const [expansion, parent] of [[ids[1]!, "TAC-034"], [ids[2]!, "TAC-108"]] as const) {
      const current = ask(expansion, parent);
      expect(JSON.parse(replayReply(current, fixture))).toEqual({
        activities: [{ id: `ACT-EXP-${expansion}`, depends_on: [{ id: `ACT-${parent}`, reason }] }],
      });
      expect(() => replayReply({ ...current, user: current.user.replace(reason, "The text cites ACT-TAC-002.") }, fixture)).toThrow(DemoReplayMissError);
    }
  });

  it("treats ID-shaped study codes and quoted source text as literal content", () => {
    const source = { stage: "S1" as const, purpose: "parse-structure:1", system: "Keep study codes verbatim.",
      user: JSON.stringify({ units: [{ unit: "u1", text: "Study TAC-001" }] }) };
    const exact = recordedCallFrom({ stage: "S1", purpose: source.purpose, system_prompt: source.system,
      user_prompt: source.user, reply: '{"units":[{"unit":"u1","blocks":[{"text":"Study TAC-001"}]}]}' });
    const fixture = { ...recording, calls: [exact] };
    expect(replayReply(source, fixture)).toContain("Study TAC-001");
    expect(() => replayReply({ ...source, user: source.user.replace("TAC-001", "TAC-002") }, fixture)).toThrow(DemoReplayMissError);
  });

  it("keeps document and identifier references consistent across the purpose, prompt and reply", () => {
    const result = replayReply({
      ...request,
      purpose: request.purpose.replace(DOC_A, DOC_B),
      user: request.user.replaceAll(DOC_A, DOC_B).replaceAll("GAP-001", "GAP-057").replaceAll("GAP-002", "GAP-053"),
    }, recording);
    expect(JSON.parse(result)).toEqual({
      gaps: [{ id: `${DOC_B}-L001`, statement: "Economic burden of recurrence", source_quote: "Payer interviews report study TAC-001." }],
    });
  });

  it.each([
    { system: "You may invent evidence gaps." },
    { user: request.user.replace("Payer interviews", "Medical interviews") },
    { user: request.user.replace("TAC-001", "TAC-002") },
    { user: request.user.replace(`"subject":"${DOC_A}-L001"`, `"subject":"${DOC_A}-L002"`) },
    { user: request.user.replace(DOC_A, DOC_B) },
    { user: request.user.replace("Primary burden", "Primary  burden") },
    { user: request.user.replace("GAP-002", "GAP-001") },
    { purpose: `gap-reviser:${DOC_B}` },
    { purpose: "another-purpose" },
    { stage: "S3" as const },
    { stage: null },
    { user: undefined } as unknown as Partial<ReplayRequest>,
  ])("rejects a changed or malformed request (%j)", (change) => {
    expect(() => replayReply({ ...request, ...change }, recording)).toThrow(DemoReplayMissError);
  });

  it("does not normalize deterministic file IDs or move another row's response", () => {
    const fileRequest = { ...request, user: JSON.stringify({ ...JSON.parse(request.user), file_id: "FILE-0123456789" }) };
    const fileRecording = {
      ...recording,
      calls: [recordedCallFrom({ stage: "S2", purpose: request.purpose, system_prompt: request.system, user_prompt: fileRequest.user, reply: "{}" })],
    };
    expect(() => replayReply({ ...fileRequest, user: fileRequest.user.replace("0123456789", "1123456789") }, fileRecording)).toThrow(DemoReplayMissError);
    expect(() => replayReply({ ...request, user: request.user.replace('"name":"Primary burden"', '"name":"Comparator"') }, recording)).toThrow(DemoReplayMissError);
  });

  it("rejects malformed and ambiguous fixtures before returning any reply", () => {
    for (const invalid of [
      { ...recording, calls: [{ ...call, ids: [DOC_A, "GAP-001", "GAP-001"] }] },
      { ...recording, calls: [{ ...call, ids: [DOC_A, "NEED-001", "GAP-002"] }] },
      { ...recording, calls: [{ ...call, ids: [DOC_A, "GAP-001"] }] },
      { ...recording, calls: [{ ...call, reply: "bad answer" }] },
      { ...recording, calls: [{ ...call, reply: '{"gaps":[{"id":"GAP-412"}]}' }] },
      { ...recording, calls: [{ ...call, reply: undefined, historical_reply: { index: 2, sha256: "changed original" } }] },
      { ...recording, calls: [call, call] },
      { ...recording, fixture: "another-pack" } as unknown as Recording,
    ]) {
      expect(() => replayReply(request, invalid)).toThrow(DemoReplayMissError);
    }
  });

  it("gives fixed recovery copy without printing request content", () => {
    const requestSecret = "private-wrong-purpose";
    expect(() => replayReply({ ...request, purpose: requestSecret }, recording)).toThrow(/Reset demo/);
    try {
      replayReply({ ...request, purpose: requestSecret }, recording);
    } catch (error) {
      expect(String(error)).not.toContain(requestSecret);
    }
  });
});

describe("demo uploads", () => {
  it("recognises each client demo document, whitespace aside, and nothing else", () => {
    for (const file of CLIENT_DEMO_PACK) {
      expect(clientDemoFileFor(file.text)?.id).toBe(file.id);
      expect(clientDemoFileFor(`\n${file.text.replace(/\n/g, "\r\n")}  \n`)?.id).toBe(file.id);
    }
    expect(clientDemoFileFor("A client's own strategy document.")).toBeNull();
    expect(clientDemoFileFor(CLIENT_DEMO_PACK[0]!.text.replace("twelve", "eleven"))).toBeNull();
  });
});

describe("demo document ids", () => {
  it("never collide with the test demo pack, so each id finds its own document", () => {
    const testIds = new Set(DEMO_PACK.map((file) => file.id));
    for (const file of CLIENT_DEMO_PACK) {
      expect(testIds.has(file.id), file.id).toBe(false);
      expect(demoSourceById(file.id)?.text).toBe(file.text);
    }
  });
});
