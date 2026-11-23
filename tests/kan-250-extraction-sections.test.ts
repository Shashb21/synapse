/** Offline production-stage regressions for complete source coverage and window-local revisions. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalParsedJson, sha256 } from "@/modules/development/documents";
import type { DevelopmentDocument } from "@/modules/development/schema";
import { executeDevelopmentSection } from "@/modules/development/stage-execution";
import type { JsonCompletion, RunHandle } from "@/modules/kernel/contracts";
import * as llm from "@/modules/kernel/llm";
import { EXTRACTION_SOURCE_LIMIT, extractionSections } from "@/modules/stages/extraction-sections";
import type { ParsedDocumentRecord } from "@/modules/stages/s1-parse/module";

const early = "The fictional North study tracks an unanswered safety question.";
const overlap = "The fictional East study tracks an unanswered persistence question.";
const boundary = "The fictional South study tracks an unanswered duration question.";
const late = "The fictional West study tracks an unanswered comparison question.";
const quotes = [early, overlap, boundary, late];
const filler = "x".repeat(100);
const recorder: RunHandle = { id: "trace", step: async (_name, fn) => fn(), note: () => {}, steps: () => [] };

function source() {
  const header = "## Fiction [block_id=long]\n";
  const text = early.padEnd(39_500 - header.length, "x") + overlap;
  const blocks = [
    { id: "long", heading: "Fiction", text: text.padEnd(39_980 - header.length, "x") + boundary + filler.repeat(430) + late, location: "1" },
    { id: "appendix", heading: "Appendix", text: early, location: "2" },
  ];
  const parsed = { blocks };
  return { id: "fiction", role: "source", compatibility: "compatible", filename: "fiction.txt", sha256: "fiction", parsed_at: "2026-01-01", parser: { name: "fiction", version: "1" }, parsed, parsed_sha256: sha256(canonicalParsedJson(parsed)) } as DevelopmentDocument;
}

type Section = "gap_extraction" | "tactic_extraction";

function finding(section: Section, quote: string) {
  const name = quote.split(" ")[2]!;
  return section === "gap_extraction"
    ? { name, statement: `How does the ${name} result inform the plan?`, domain: "comparative_effectiveness", source_quote: quote }
    : { name, type: "registry", status: "ongoing", evidence_question: `What is the ${name} result?`, source_quote: quote };
}

beforeEach(() => vi.spyOn(llm, "isTestStub").mockReturnValue(false));
afterEach(() => vi.restoreAllMocks());

describe("complete gap and tactic extraction", () => {
  it("covers every character of oversized blocks and headings with bounded sections", () => {
    const blocks = [
      { id: "b1", heading: "h".repeat(42_000), text: "a".repeat(83_000) },
      { id: "b2", heading: "End", text: "last" },
    ];
    const windows = extractionSections({ id: "doc", blocks } as ParsedDocumentRecord);
    const expected = blocks.map(b => `## ${b.heading} [block_id=${b.id}]\n${b.text}`).join("\n\n");
    let covered = 0;
    for (const section of windows) {
      expect(section.body.length).toBeLessThanOrEqual(EXTRACTION_SOURCE_LIMIT);
      const start = covered === 0 ? 0 : covered - 1_000;
      expect(section.body).toBe(expected.slice(start, start + section.body.length));
      covered = start + section.body.length;
    }
    expect(covered).toBe(expected.length);
  });

  it("advances after a block ends one character beyond the carried context", () => {
    const heading = "## A [block_id=b1]\n";
    const blocks = [
      { id: "b1", heading: "A", text: "a".repeat(1_001 - heading.length) },
      { id: "b2", heading: "B", text: "b".repeat(80_000) + late },
    ];
    const windows = extractionSections({ id: "doc", blocks } as ParsedDocumentRecord);
    expect(windows[0].body).toHaveLength(1_001);
    expect(windows[1].body.startsWith(windows[0].body.slice(1))).toBe(true);
    expect(windows).toHaveLength(4);
    expect(windows.at(-1)?.body).toContain(late);
  });

  it("preserves Development block resolution for existing stub rows without block IDs", async () => {
    vi.mocked(llm.isTestStub).mockReturnValue(true);
    const snapshot = source();
    snapshot.parsed = { blocks: [{ id: "legacy", heading: "Evidence gap", text: "There is no evidence of comparative effectiveness in the fictional population.", location: "1" }] };
    snapshot.parsed_sha256 = sha256(canonicalParsedJson(snapshot.parsed));
    const complete = vi.fn<JsonCompletion>();
    const result = await executeDevelopmentSection({ section: "gap_extraction", mode: "single_pass", sources: [snapshot], prerequisites: {}, recorder, complete });
    expect(complete).not.toHaveBeenCalled();
    expect(result.candidates[0]).not.toHaveProperty("block_id");
    expect(result.local_state.needs[0].block_id).toBe("fiction:legacy");
    expect(result.local_state.needs[0].block_id).toBe(result.local_state.blocks[0].id);
  });

  for (const section of ["gap_extraction", "tactic_extraction"] as const) {
    const isGap = section === "gap_extraction";
    const list = isGap ? "gaps" : "tactics";
    it.each(["single_pass", "standard"] as const)(`${section} preserves late evidence and source identities in %s`, async mode => {
      const revisionBlocks = new Set<string>();
      const complete = vi.fn<JsonCompletion>(async request => {
        if (request.role === "proposer") {
          return { [list]: quotes.filter(quote => request.user.includes(quote)).map(quote => finding(section, quote)) };
        }
        const body = JSON.parse(request.user);
        if (request.role === "reviser") {
          const rows: { id: string; source_quote?: string; previous?: { source_quote: string } }[] = isGap ? body.candidates : body.rows;
          expect(body.document.length).toBeLessThanOrEqual(EXTRACTION_SOURCE_LIMIT);
          return { [list]: rows.map(row => {
            const quote = (row.source_quote ?? row.previous?.source_quote)!;
            expect(body.document).toContain(quote);
            revisionBlocks.add(row.id);
            return { id: row.id, ...finding(section, quote) };
          }) };
        }
        expect(request.user).not.toContain(filler);
        if (request.role === "critic") {
          return { [isGap ? "critiques" : "reviews"]: body.candidates.map((row: { subject?: string; id?: string }) =>
            ({ ...row, confidence: 80, note: "Check the source wording.", verdict: "revise" })) };
        }
        const decisions: { subject?: string; id?: string; decide?: boolean }[] = isGap ? body.candidates : body.decide;
        return { decisions: decisions.filter(row => row.decide !== false).map(row =>
          ({ ...row, match: "new", target_tactic_id: null, verdict: "accept", confidence: 82, reason: "Supported by this fictional source." })) };
      });
      const result = await executeDevelopmentSection({ section, mode, sources: [source()], prerequisites: {}, recorder, complete });
      expect(result.candidates.map(row => [row.source_quote, row.block_id])).toEqual([
        [early, "long"], [overlap, "long"], [boundary, "long"], [early, "appendix"], [late, "long"],
      ]);
      const ids = result.candidates.map(row => row.id as string);
      expect(new Set(ids).size).toBe(5);
      expect(result.review_status).toBe("unreviewed");
      expect(result.candidates.every(row => row.source_id === "fiction" && row.document_id === "fiction")).toBe(true);
      if (isGap) expect(result.local_state.needs.filter(need => need.source_quote === early).at(-1)?.block_id).toBe("fiction:appendix");
      if (mode === "standard") expect(revisionBlocks).toEqual(new Set(ids));
      else expect(complete.mock.calls.every(([request]) => request.role === "proposer")).toBe(true);
    });

    it(`${section} repairs an incomplete late proposal using its own section during single pass`, async () => {
      let repaired = false;
      const complete: JsonCompletion = async request => {
        expect(request.role).toBe("proposer");
        if (!request.user.startsWith("{")) {
          const rows = request.user.includes(late) ? [{ ...finding(section, late), source_quote: "" }] : [];
          return { [list]: rows };
        }
        const body = JSON.parse(request.user);
        expect(body.document).toContain(late);
        expect(body.document).not.toContain(boundary);
        expect(body.document.length).toBeLessThanOrEqual(EXTRACTION_SOURCE_LIMIT);
        const [{ id }] = isGap ? body.candidates : body.rows;
        repaired = true;
        return { [list]: [{ ...finding(section, late), id }] };
      };
      const result = await executeDevelopmentSection({ section, mode: "single_pass", sources: [source()], prerequisites: {}, recorder, complete });
      expect(repaired).toBe(true);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ source_quote: late, block_id: "long" });
    });

    it(`${section} propagates a late coverage failure instead of returning the earlier findings`, async () => {
      const interrupted = new Error("fictional provider interruption");
      const steps: string[] = [];
      const note = vi.fn<RunHandle["note"]>();
      const run: RunHandle = { ...recorder, note, step: async (name, fn) => { steps.push(name); return fn(); } };
      const complete: JsonCompletion = async request => {
        if (request.user.includes(late)) throw interrupted;
        return { [list]: [] };
      };
      await expect(executeDevelopmentSection({ section, mode: "single_pass", sources: [source()], prerequisites: {}, recorder: run, complete })).rejects.toBe(interrupted);
      expect(steps.at(-1)).toMatch(/fiction section 3\/3/);
      expect(note).toHaveBeenCalledWith("extraction:incomplete", { document_id: "fiction", section: 3, document_sections: 3, completed_sections: 2, total_sections: 3 });
    });
  }
});
