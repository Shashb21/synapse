import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_DEMO_PACK } from "@/lib/demo/client-pack";
import { replayReply } from "@/lib/demo/replay";
import { parseWithLlm } from "@/lib/ingest/llm-structure";
import { extractJsonObject } from "@/lib/llm/anthropic";
import { buildClientDemoWorkspace } from "@/lib/iegp/blank";
import type { ModuleContext, RunHandle, StageId } from "@/modules/kernel/contracts";
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

  it("runs the approved first document through parsing, the real gap cycle and the real tactic cycle with fresh IDs", async () => {
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    const file = CLIENT_DEMO_PACK[0]!;
    const parsed = await parse(file);
    const sourceId = "SRC-053";
    const doc: ParsedDocumentRecord = {
      id: "DOC_20261125T123456_16384_5x2y", source_id: sourceId, file_id: file.id,
      parsed_at: "2026-11-25T12:34:56.000Z", parser: "llm", parser_version: "2.0.0", duration_ms: 0,
      blocks: parsed.document.blocks.map((block, i) => ({
        id: `BLK-${String(501 + i)}`, source_id: sourceId,
        heading: block.heading ?? block.location.ref, location: block.location.ref, text: block.text,
      })),
      quality: { blocks: parsed.document.blocks.length, characters: 100, avg_block_chars: 2, empty_blocks: 0, need_cue_blocks: 1, tactic_cue_blocks: 1, warnings: [] },
    };
    const state = buildClientDemoWorkspace();
    const context = (stage: StageId): ModuleContext => ({
      workspace_id: "offline-fictional-demo",
      actor: { name: "Presenter", function: "medical_affairs" },
      role: "medical_affairs",
      run: {
        id: "offline-fictional-demo", step: async <T,>(_name: string, fn: () => Promise<T>) => fn(), note: () => undefined,
      } as unknown as RunHandle,
      route: { stage, provider_id: "fixture-test", provider_label: "Fictional fixture test", model: "recorded", auth: "api_key", connected: true, params: { temperature: 0, max_tokens: 16000 }, fallbacks: [], degraded: false, reason: null },
      ai: true,
      complete: complete(stage),
      replay: { evaluation: true, input: {}, facts: { documents: [doc], state }, module_id: "fixture-test", module_version: "1", prompt_version: "v1.0-baseline" },
    });
    const input = { document_ids: [doc.id], dry_run: true };
    const gaps = await gapExtractModule.run(input, context("S2"));
    const tactics = await tacticExtractModule.run(input, context("S3"));
    expect(gaps.output.accepted).toHaveLength(9);
    expect(tactics.output.accepted).toHaveLength(9);
    for (const candidate of [...gaps.output.accepted, ...tactics.output.accepted]) {
      expect(candidate).toMatchObject({ document_id: doc.id, source_id: sourceId });
    }
  });
});
