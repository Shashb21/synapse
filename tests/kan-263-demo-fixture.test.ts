import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import { DemoReplayMissError, recordedCallFrom, replayReply, type Recording, type ReplayRequest } from "@/lib/demo/replay";
import { VELMARA_DEMO_FIXTURE } from "@/lib/demo/replay-provider";
import { parseWithLlm } from "@/lib/ingest/llm-structure";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { buildClientDemoWorkspace } from "@/lib/iegp/blank";
import type { ModuleContext, StageId } from "@/modules/kernel/contracts";
import type { ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";
import { gapExtractModule } from "@/modules/stages/s2-gap-extract/module";
import { tacticExtractModule } from "@/modules/stages/s3-tactic-extract/module";
import { timelineAnchor } from "@/modules/stages/s10-timeline/module";

const complete = (stage: StageId): ModuleContext["complete"] => async request =>
  extractJsonObject(replayReply({ stage, ...request }));

const parse = (file: (typeof CLIENT_DEMO_PACK)[number]) => parseWithLlm({
  filename: file.filename, buffer: Buffer.from(file.text), mime: "text/plain", ask: complete("S1"),
});

afterEach(() => vi.unstubAllEnvs());

describe("KAN-263 approved fictional fixture", () => {
  it("pins the Velmara plan date while preserving the editable live date", () => {
    const today = "2026-11-25T12:00:00.000Z";
    expect(timelineAnchor(undefined, true, today)).toBe("2026-10-19");
    expect(timelineAnchor("2026-10-19", true, today)).toBe("2026-10-19");
    expect(() => timelineAnchor("2026-10-20", true, today)).toThrow(/Reset demo/);
    expect(timelineAnchor("2026-10-20", false, today)).toBe("2026-10-20");
    expect(timelineAnchor(undefined, false, today)).toBe("2026-11-25");
  });

  it("parses all seven source files through current coverage validation and classification", async () => {
    const results = await Promise.all(CLIENT_DEMO_PACK.map(parse));
    expect(results.map(result => result.document.blocks.length)).toEqual([56, 63, 68, 60, 74, 57, 53]);
    const fieldMedical = results.at(-1)!;
    expect(fieldMedical.document.blocks.some(block => block.text.startsWith('- "Response rate in the brain is not enough;'))).toBe(true);
    expect(fieldMedical.stakeholder_rationale).toBeTruthy();
  });

  it("refuses another approved source under the first file's name", async () => {
    await expect(parse({ ...CLIENT_DEMO_PACK[0]!, text: CLIENT_DEMO_PACK[1]!.text })).rejects.toMatchObject({ code: "demo_replay_miss" });
  });

  it.each([
    {
      stage: "S2", module: gapExtractModule, purpose: "gap-proposer", replyKey: "gaps",
      blockRule: " and give the containing block ID in block_id",
    },
    {
      stage: "S3", module: tacticExtractModule, purpose: "tactic-proposer", replyKey: "tactics",
      blockRule: "- block_id: the ID of the block containing the full quotation.\n",
    },
  ] as const)("$stage refuses the current extraction request with fresh IDs and preserves the historical reply", async ({
    stage, module, purpose, replyKey, blockRule,
  }) => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    const file = CLIENT_DEMO_PACK[0]!;
    const parsed = await parse(file);
    const state = buildClientDemoWorkspace();
    const currentRequests: ReplayRequest[] = [];

    for (const [sourceId, documentId] of [
      ["SRC-053", "DOC_20261125T123456_16384_5x2y"],
      ["SRC-117", "DOC_20261201T090000_27183_9q2s"],
    ] as const) {
      const doc: ParsedDocumentRecord = {
        id: documentId, source_id: sourceId, file_id: file.id,
        parsed_at: "2026-11-25T12:34:56.000Z", parser: "llm", parser_version: "2.0.0", duration_ms: 0,
        blocks: parsed.document.blocks.map((block, i) => ({
          id: `${sourceId}-B${String(i + 1).padStart(2, "0")}`, source_id: sourceId,
          heading: block.heading ?? block.location.ref, location: block.location.ref, text: block.text,
        })),
        quality: { blocks: parsed.document.blocks.length, characters: 100, avg_block_chars: 2, empty_blocks: 0, need_cue_blocks: 1, tactic_cue_blocks: 1, warnings: [] },
      };
      const ask = vi.fn(complete(stage));
      const note = vi.fn();
      const context: ModuleContext = {
        workspace_id: "offline-fictional-demo",
        actor: { name: "Presenter", function: "medical_affairs" },
        role: "medical_affairs",
        run: { id: "offline-fictional-demo", step: async (_name, fn) => fn(), note, steps: () => [] },
        route: { stage, provider_id: "fixture-test", provider_label: "Fictional fixture test", model: "recorded", auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 16000 }, fallbacks: [], degraded: false, reason: null },
        ai: true,
        complete: ask,
        replay: { evaluation: true, input: {}, facts: { documents: [doc], state }, module_id: "fixture-test", module_version: "1", prompt_version: "v1.0-baseline" },
      };

      const extraction = module.run({ document_ids: [doc.id], dry_run: true }, context);
      await expect(extraction).rejects.toMatchObject({
        name: "DemoReplayMissError", code: "demo_replay_miss", status: 409, message: expect.stringContaining("Reset demo"),
      });
      expect(ask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        purpose: `${purpose}:${documentId}`, role: "proposer", system: expect.stringContaining(blockRule),
        user: expect.stringContaining(`[block_id=${doc.blocks[0]!.id}]`),
      }));
      expect(note).toHaveBeenCalledWith("extraction:incomplete", expect.objectContaining({
        document_id: documentId, section: 1, completed_sections: 0,
      }));

      const demoAsk = vi.fn(complete(stage));
      await expect(module.run({ document_ids: [doc.id], dry_run: false }, {
        ...context,
        route: {
          ...context.route, provider_id: "demo-replay", auth: "none",
          demo: { workspace_id: context.workspace_id, fixture: VELMARA_DEMO_FIXTURE, mode: "replay" },
        },
        complete: demoAsk,
        replay: { ...context.replay!, evaluation: false },
      })).rejects.toMatchObject({ code: "demo_replay_miss", status: 409 });
      expect(demoAsk).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ user: expect.stringContaining("[block_id=block-1]") }));

      // Compare the exact pre-KAN-250 request for this short document. Its body
      // had the same headings and text without the generated block annotations.
      const [request] = ask.mock.calls[0]!;
      currentRequests.push({ ...request, stage });
      const user = doc.blocks.reduce((prompt, { heading, id }) =>
        prompt.replace(`## ${heading} [block_id=${id}]\n`, `## ${heading}\n`), request.user);
      const system = request.system.replace(blockRule, "").replace(',"block_id":""', "");
      const historicalReply = extractJsonObject(replayReply({ ...request, stage, user, system })) as Record<string, unknown>;
      expect(historicalReply[replyKey]).toHaveLength(11);
      expect(() => replayReply({ ...request, stage, user })).toThrow(DemoReplayMissError);
      expect(() => replayReply({ ...request, stage, system })).toThrow(DemoReplayMissError);
    }

    // Evaluation prompts keep the original block IDs and are exact as written.
    const [opening, afterReset] = currentRequests;
    const reply = JSON.stringify({ [replyKey]: [] });
    const entry = recordedCallFrom({
      stage, purpose: opening!.purpose, system_prompt: opening!.system, user_prompt: opening!.user, reply,
    });
    const sample = { version: 3, fixture: VELMARA_DEMO_FIXTURE, recorded_at: null, calls: [entry] } satisfies Recording;
    expect(replayReply(opening!, sample)).toBe(reply);
    expect(() => replayReply(afterReset!, sample)).toThrow(DemoReplayMissError);
  });
});
