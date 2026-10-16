import { describe, expect, it } from "vitest";
import {
  DemoReplayMissError,
  findRecordedCall,
  idMapping,
  idsIn,
  normalizePrompt,
  recordedCallFrom,
  replayReply,
  similarity,
  type Recording,
} from "@/lib/demo/replay";
import { clientDemoFileFor } from "@/lib/demo/client-files";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";

/** KAN-138: a client-demo workspace answers every AI step from the recorded run. */

const DOC_A = "DOC_20261016T101500_0001_ab12";
const DOC_B = "DOC_20261118T093000_0042_zz99";

describe("ids and prompts", () => {
  it("finds the ids the app mints, and leaves content tokens alone", () => {
    const text = `Gap GAP-012 cites NEED-104 from ${DOC_A} (file FILE-0123456789); VEL-301, EGFR-mutant and QLQ-C30 are content.`;
    expect(idsIn(text)).toEqual(["GAP-012", "NEED-104", DOC_A, "FILE-0123456789"]);
    expect(normalizePrompt(text)).toBe(
      "Gap ⟨GAP⟩ cites ⟨NEED⟩ from ⟨DOC⟩ (file ⟨FILE⟩); VEL-301, EGFR-mutant and QLQ-C30 are content.",
    );
  });

  it("maps the recorded run's ids onto this run's by kind and order", () => {
    const map = idMapping(["GAP-001", "NEED-001", "GAP-002", DOC_A], ["GAP-031", "NEED-090", "GAP-032", DOC_B]);
    expect(Object.fromEntries(map)).toEqual({ "GAP-001": "GAP-031", "NEED-001": "NEED-090", "GAP-002": "GAP-032", [DOC_A]: DOC_B });
  });

  it("scores identical prompts 1 and unrelated ones low", () => {
    expect(similarity("elderly comparative effectiveness", "elderly comparative effectiveness")).toBe(1);
    expect(similarity("elderly comparative effectiveness versus chemotherapy", "intracranial response brain metastases")).toBeLessThan(0.2);
  });
});

const recording: Recording = {
  recorded_at: "2026-10-16T10:00:00Z",
  calls: [
    recordedCallFrom({
      stage: "S2",
      purpose: `gap-proposer:${DOC_A}`,
      system_prompt: "You propose evidence gaps.",
      user_prompt: `Document ${DOC_A}: payer interviews on the economic burden of recurrence and elderly comparative effectiveness.`,
      reply: JSON.stringify({ candidates: [{ id: `${DOC_A}-L001`, statement: "Economic burden of recurrence" }] }),
    }),
    recordedCallFrom({
      stage: "S2",
      purpose: `gap-proposer:${DOC_A}`,
      system_prompt: "You propose evidence gaps.",
      user_prompt: `Document ${DOC_A}: KOL advisory board on intracranial response and brain metastases.`,
      reply: JSON.stringify({ candidates: [{ id: `${DOC_A}-L001`, statement: "Intracranial duration of response" }] }),
    }),
    recordedCallFrom({
      stage: "S8",
      purpose: "priority-suggester",
      system_prompt: "You suggest priority bands.",
      user_prompt: "Gaps: GAP-001 economic burden; GAP-002 elderly comparative effectiveness.",
      reply: JSON.stringify({ placements: [{ gap_id: "GAP-001", band: "high" }, { gap_id: "GAP-002", band: "high" }] }),
    }),
  ],
};

describe("replaying a call", () => {
  it("answers each document's call with that document's recorded reply, under this run's ids", () => {
    const reply = replayReply(
      {
        stage: "S2",
        purpose: `gap-proposer:${DOC_B}`,
        system: "You propose evidence gaps.",
        user: `Document ${DOC_B}: KOL advisory board on intracranial response and brain metastases.`,
      },
      recording,
    );
    expect(JSON.parse(reply)).toEqual({ candidates: [{ id: `${DOC_B}-L001`, statement: "Intracranial duration of response" }] });
  });

  it("maps gap ids in a later stage's reply onto the gaps this run has", () => {
    const reply = replayReply(
      {
        stage: "S8",
        purpose: "priority-suggester",
        system: "You suggest priority bands.",
        user: "Gaps: GAP-047 economic burden; GAP-048 elderly comparative effectiveness.",
      },
      recording,
    );
    expect(JSON.parse(reply).placements.map((p: { gap_id: string }) => p.gap_id)).toEqual(["GAP-047", "GAP-048"]);
  });

  it("still finds the closest recorded call when this prompt differs a little", () => {
    const found = findRecordedCall(
      { stage: "S2", purpose: `gap-proposer:${DOC_B}`, system: "x", user: `Document ${DOC_B}: payer interviews about the burden of recurrence.` },
      recording,
    );
    expect(found?.reply).toContain("Economic burden of recurrence");
  });

  it("says so, in plain words, for a step the recording does not have", () => {
    expect(() => replayReply({ stage: "S9", purpose: "ideation-proposer", system: "", user: "" }, recording)).toThrow(DemoReplayMissError);
    expect(() => replayReply({ stage: "S9", purpose: "ideation-proposer", system: "", user: "" }, recording)).toThrow(/not part of the recorded client demo/);
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
