import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/modules";
import { NoRouteError } from "@/modules/llm/provider";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { parseWithLlm, structureWithLlm, type RawUnit } from "@/lib/ingest/llm-structure";
import { parseModule as s1ParseModule } from "@/modules/stages/s1-parse/module";

/**
 * Parsing on the chosen LLM: text is extracted mechanically, the model decides
 * the blocks. LlamaParse is never selected, and nothing parses without a model.
 */

type Call = { purpose: string; body: Record<string, unknown> };

const units: RawUnit[] = [
  { location: { kind: "slide", ref: "Slide 1" }, text: "Velmara evidence plan 2026" },
  {
    location: { kind: "slide", ref: "Slide 2" },
    text: "Comparative evidence. No head-to-head data versus osimertinib for the HTA dossier.",
  },
  { location: { kind: "slide", ref: "Slide 3" }, text: "Confidential - page 3" },
];

function scripted(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const ask = async ({ purpose, user }: { system: string; user: string; purpose: string }) => {
    const call = { purpose, body: JSON.parse(user) as Record<string, unknown> };
    calls.push(call);
    return answer(call);
  };
  return { ask, calls };
}

const idsOf = (call: Call) => (call.body.units as { unit: string }[]).map((row) => row.unit);

const good = (id: string) =>
  ({
    u1: { unit: "u1", blocks: [{ text: "Velmara evidence plan 2026", kind: "title", heading: null }] },
    u2: {
      unit: "u2",
      blocks: [
        { text: "Comparative evidence.", kind: "heading", heading: null },
        {
          text: "No head-to-head data versus osimertinib for the HTA dossier.",
          kind: "paragraph",
          heading: "Comparative evidence.",
        },
      ],
    },
    u3: { unit: "u3", blocks: [], dropped_reason: "Confidentiality footer and page number." },
  })[id];

describe("LLM structuring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps a unit at the source-text cap as one prompt unit", async () => {
    const text = "a".repeat(12_000);
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return { unit: id, blocks: [{ text: row.text, kind: "paragraph", heading: null }] };
      }),
    }));

    const result = await structureWithLlm({
      filename: "long.txt",
      units: [{ location: { kind: "page", ref: "p.1" }, text }],
      ask,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.units).toEqual([{ unit: "u1", location: "p.1", text }]);
    expect(result.blocks).toEqual([{ text, kind: "paragraph", location: { kind: "page", ref: "p.1" } }]);
  });

  it("splits a unit over the cap before assigning prompt ids and keeps repeated text distinct", async () => {
    const text = `${"same ".repeat(2_399)}sameXY`;
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return { unit: id, blocks: [{ text: row.text, kind: "paragraph", heading: null }] };
      }),
    }));

    const result = await structureWithLlm({
      filename: "long.txt",
      units: [{ location: { kind: "page", ref: "p.1" }, text }],
      ask,
    });

    expect(calls.map((call) => idsOf(call))).toEqual([["u1"], ["u2"]]);
    const parts = calls.map((call) => (call.body.units as { text: string }[])[0]!.text);
    expect(parts.join(""), "split pieces retain repeated source text in order").toBe(text);
    expect(parts.every((part) => part.length <= 12_000)).toBe(true);
    expect(parts).toEqual([`${"same ".repeat(2_399)}sameX`, "Y"]);
    expect(result.blocks.map((block) => block.text).join("")).toBe(text);
    expect(result.blocks.every((block) => block.location.ref === "p.1")).toBe(true);
  });

  it("does not split a UTF-16 surrogate pair and preserves accepted and dropped order", async () => {
    const first = "x".repeat(11_999);
    const text = `${first}😀tail`;
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return id === "u1"
          ? { unit: id, blocks: [{ text: row.text, kind: "paragraph", heading: null }] }
          : { unit: id, blocks: [], dropped_reason: "footer" };
      }),
    }));

    const result = await structureWithLlm({
      filename: "unicode.txt",
      units: [{ location: { kind: "page", ref: "p.7" }, text }],
      ask,
    });

    const parts = calls.map((call) => (call.body.units as { text: string }[])[0]!.text);
    expect(parts).toEqual([first, "😀tail"]);
    expect(parts.join(""), "surrogate-safe parts retain exact source order").toBe(text);
    expect(parts[0]!.endsWith("\uD83D")).toBe(false);
    expect(parts[1]!.startsWith("\uDE00")).toBe(false);
    expect(result.blocks).toEqual([{ text: first, kind: "paragraph", location: { kind: "page", ref: "p.7" } }]);
    expect(result.dropped).toEqual([{ location: "p.7", reason: "footer" }]);
    expect(result.dropped_units).toEqual([{ location: "p.7", reason: "footer", text: "😀tail", occurrence_id: "u2" }]);
  });

  it("reconstructs accepted and dropped split pieces with boundary whitespace intact", async () => {
    const accepted = `${"a".repeat(11_999)} `;
    const dropped = " footer";
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return id === "u1"
          ? { unit: id, blocks: [{ text: row.text, kind: "paragraph", heading: null }] }
          : { unit: id, blocks: [], dropped_reason: "footer" };
      }),
    }));

    const result = await structureWithLlm({
      filename: "boundary-whitespace.txt",
      units: [{ location: { kind: "page", ref: "p.9" }, text: accepted + dropped }],
      ask,
    });

    expect(calls.map((call) => idsOf(call))).toEqual([["u1"], ["u2"]]);
    expect(result.blocks).toEqual([{ text: accepted, kind: "paragraph", location: { kind: "page", ref: "p.9" } }]);
    expect(result.dropped_units).toEqual([{ location: "p.9", reason: "footer", text: dropped, occurrence_id: "u2" }]);
  });

  it("materializes split blocks from source ranges when the model trims and collapses whitespace", async () => {
    const first = `${"a".repeat(11_999)} `;
    const second = " B  C";
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return { unit: id, blocks: [{ text: row.text.trim().replace(/\s+/g, " "), kind: "paragraph", heading: null }] };
      }),
    }));

    const result = await structureWithLlm({
      filename: "materialize-ranges.txt",
      units: [{ location: { kind: "page", ref: "p.11" }, text: first + second }],
      ask,
    });

    expect(calls.map((call) => idsOf(call))).toEqual([["u1"], ["u2"]]);
    expect(result.blocks.map((block) => block.text)).toEqual([first, second]);
    expect(result.blocks.map((block) => block.text).join("")).toBe(first + second);
  });

  it("preserves whitespace gaps between multiple accepted blocks in one split piece", async () => {
    const left = `${"L".repeat(6_000)}Alpha`;
    const gap = "  \n\n";
    const right = `Beta${"R".repeat(5_987)}`;
    const firstPiece = left + gap + right;
    const secondPiece = "tail";
    expect(firstPiece).toHaveLength(12_000);
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return id === "u1"
          ? {
              unit: id,
              blocks: [
                { text: left, kind: "paragraph", heading: null },
                { text: right, kind: "paragraph", heading: null },
              ],
            }
          : { unit: id, blocks: [{ text: row.text, kind: "paragraph", heading: null }] };
      }),
    }));

    const result = await structureWithLlm({
      filename: "multi-block-gap.txt",
      units: [{ location: { kind: "page", ref: "p.12" }, text: firstPiece + secondPiece }],
      ask,
    });

    expect(calls.map((call) => idsOf(call))).toEqual([["u1"], ["u2"]]);
    expect(result.blocks.map((block) => block.text)).toEqual([left + gap, right, secondPiece]);
    expect(result.blocks.map((block) => block.text).join("")).toBe(firstPiece + secondPiece);
  });

  it("keeps identical split pieces as separate accepted occurrences", async () => {
    const piece = "same".repeat(3_000);
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return { unit: id, blocks: [{ text: row.text, kind: "paragraph", heading: null }] };
      }),
    }));

    const result = await structureWithLlm({
      filename: "repeated-pieces.txt",
      units: [{ location: { kind: "page", ref: "p.10" }, text: `${piece}${piece}tail` }],
      ask,
    });

    expect(calls.map((call) => idsOf(call))).toEqual([["u1"], ["u2"], ["u3"]]);
    expect(result.blocks.map((block) => block.text)).toEqual([piece, piece, "tail"]);
  });

  it("keeps a whitespace-only continuation available for an explicit drop", async () => {
    const text = `${"a".repeat(12_000)}   `;
    const { ask, calls } = scripted((call) => ({
      units: idsOf(call).map((id) => {
        const row = (call.body.units as { unit: string; text: string }[]).find((unit) => unit.unit === id)!;
        return id === "u1"
          ? { unit: id, blocks: [{ text: row.text, kind: "paragraph", heading: null }] }
          : { unit: id, blocks: [], dropped_reason: "trailing whitespace" };
      }),
    }));

    const result = await structureWithLlm({
      filename: "whitespace.txt",
      units: [{ location: { kind: "page", ref: "p.8" }, text }],
      ask,
    });

    expect(calls.map((call) => idsOf(call))).toEqual([["u1"], ["u2"]]);
    expect(result.blocks).toEqual([{ text: "a".repeat(12_000), kind: "paragraph", location: { kind: "page", ref: "p.8" } }]);
    expect(result.dropped_units).toEqual([{ location: "p.8", reason: "trailing whitespace", text: "   ", occurrence_id: "u2" }]);
  });

  it("rejects split groups over the configured call budget before calling the model", async () => {
    vi.stubEnv("SYNAPSE_MAX_PARSE_CALLS", "1");
    const ask = vi.fn();

    await expect(
      structureWithLlm({
        filename: "over-budget.txt",
        units: [{ location: { kind: "page", ref: "p.1" }, text: "z".repeat(12_001) }],
        ask,
      }),
    ).rejects.toThrow(/would take 2 model calls/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("counts every split piece toward the configured section limit before calling the model", async () => {
    vi.stubEnv("SYNAPSE_MAX_PARSE_UNITS", "1");
    const ask = vi.fn();

    await expect(
      structureWithLlm({
        filename: "over-sections.txt",
        units: [{ location: { kind: "page", ref: "p.1" }, text: "z".repeat(12_001) }],
        ask,
      }),
    ).rejects.toThrow(/has 2 sections of text/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("takes every block, kind and heading from the model and records dropped noise", async () => {
    const { ask, calls } = scripted((call) => ({ units: idsOf(call).map(good) }));
    const { blocks, dropped, dropped_units } = await structureWithLlm({ filename: "deck.pptx", units, ask });

    expect(calls).toHaveLength(1);
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["title", "Velmara evidence plan 2026"],
      ["heading", "Comparative evidence."],
      ["paragraph", "No head-to-head data versus osimertinib for the HTA dossier."],
    ]);
    expect(blocks[2]).toMatchObject({ heading: "Comparative evidence.", location: { ref: "Slide 2" } });
    expect(dropped).toEqual([{ location: "Slide 3", reason: "Confidentiality footer and page number." }]);
    expect(dropped_units).toEqual([{
      location: "Slide 3",
      reason: "Confidentiality footer and page number.",
      text: "Confidential - page 3",
    }]);
  });

  it("re-asks for a unit whose block is not a verbatim span, or that was left out", async () => {
    let first = true;
    const { ask, calls } = scripted((call) => {
      if (first) {
        first = false;
        // u2 is paraphrased, u3 is missing.
        return {
          units: [
            good("u1"),
            { unit: "u2", blocks: [{ text: "There is no comparative data.", kind: "paragraph", heading: null }] },
          ],
        };
      }
      return { units: idsOf(call).map(good) };
    });

    const { blocks } = await structureWithLlm({ filename: "deck.pptx", units, ask });

    expect(idsOf(calls[1]!)).toEqual(["u2", "u3"]);
    expect(calls[1]!.body.note).toMatch(/verbatim/);
    expect(blocks.some((block) => block.text === "There is no comparative data.")).toBe(false);
  });

  it("fails the parse when the model never returns a valid answer for a unit", async () => {
    const { ask } = scripted((call) => ({
      units: idsOf(call)
        .filter((id) => id !== "u2")
        .map(good),
    }));
    await expect(structureWithLlm({ filename: "deck.pptx", units, ask })).rejects.toThrow(
      /did not return a complete parse for Slide 2/,
    );
  });

  it.each([
    { scenario: "omits the final qualification", texts: ["Data are available.", "Adults only."] },
    { scenario: "omits the leading sentence", texts: ["Adults only.", "Follow-up is pending."] },
    { scenario: "omits a middle sentence", texts: ["Data are available.", "Follow-up is pending."] },
    { scenario: "reorders sentences", texts: ["Adults only.", "Data are available.", "Follow-up is pending."] },
    {
      scenario: "repeats a sentence beyond its source occurrences",
      texts: ["Data are available.", "Adults only.", "Adults only.", "Follow-up is pending."],
    },
  ])("re-asks only for the unit when the model $scenario", async ({ texts }) => {
    const completeText = "Data are available. Adults only. Follow-up is pending.";
    const { ask, calls } = scripted(() =>
      calls.length === 1
        ? {
            units: [
              good("u1"),
              { unit: "u2", blocks: texts.map((text) => ({ text, kind: "paragraph", heading: null })) },
              good("u3"),
            ],
          }
        : {
            units: [{
              unit: "u2",
              blocks: [{ text: completeText, kind: "paragraph", heading: null }],
            }],
          },
    );
    const sourceUnits = [
      units[0]!,
      { location: { kind: "slide" as const, ref: "Slide 2" }, text: completeText },
      units[2]!,
    ];

    const { blocks } = await structureWithLlm({ filename: "deck.pptx", units: sourceUnits, ask });

    expect(calls.map(idsOf)).toEqual([["u1", "u2", "u3"], ["u2"]]);
    expect(blocks.filter((block) => block.location.ref === "Slide 2").map((block) => block.text)).toEqual([completeText]);
  });

  it("accepts complete verbatim splits across whitespace and within words, including actual repeated text", async () => {
    const { ask, calls } = scripted(() => ({
      units: [{
        unit: "u1",
        blocks: ["Data are avail", "able.", "Adults\tonly.", "Adults only."].map((text) => ({
          text,
          kind: "paragraph",
          heading: null,
        })),
      }],
    }));

    const { blocks } = await structureWithLlm({
      filename: "report.txt",
      units: [{ location: { kind: "page", ref: "p.1" }, text: "  Data are available.\n\nAdults only.   Adults only.  " }],
      ask,
    });

    expect(calls).toHaveLength(1);
    expect(blocks.map((block) => block.text)).toEqual(["Data are avail", "able.", "Adults\tonly.", "Adults only."]);
  });

  it("fails before stakeholder classification when the model repeatedly returns only a prefix with a drop reason", async () => {
    const { ask, calls } = scripted((call) =>
      call.purpose === "parse-stakeholder"
        ? { stakeholder_function: "market_access", rationale: "Evidence plan." }
        : {
            units: [{
              unit: "u1",
              blocks: [{ text: "Data are available.", kind: "paragraph", heading: null }],
              dropped_reason: "Footer.",
            }],
          },
    );

    await expect(parseWithLlm({
      filename: "report.txt",
      buffer: Buffer.from("Data are available. Adults only."),
      mime: "text/plain",
      ask,
    })).rejects.toThrow(/did not return a complete parse for p\.1 \(u1\)/);
    expect(calls.map((call) => call.purpose)).toEqual(["parse-structure:1", "parse-structure:1", "parse-structure:1"]);
  });

  it("an emptied unit must say why it was dropped", async () => {
    let first = true;
    const { ask, calls } = scripted((call) => {
      if (first) {
        first = false;
        return { units: [good("u1"), good("u2"), { unit: "u3", blocks: [] }] };
      }
      return { units: idsOf(call).map(good) };
    });
    await structureWithLlm({ filename: "deck.pptx", units, ask });
    expect(idsOf(calls[1]!)).toEqual(["u3"]);
  });

  it("the model, not the filename, classifies the stakeholder function", async () => {
    const text = "Payer feedback\n\nThe payer panel wants budget impact data before the HTA submission.";
    let stakeholderAsks = 0;
    const { ask } = scripted((call) => {
      if (call.purpose === "parse-stakeholder") {
        stakeholderAsks += 1;
        return stakeholderAsks === 1
          ? { stakeholder_function: "finance", rationale: "money" }
          : { stakeholder_function: "market_access", rationale: "Payer and HTA feedback." };
      }
      const rows = call.body.units as { unit: string; text: string }[];
      return { units: rows.map((row) => ({ unit: row.unit, blocks: [{ text: row.text, kind: "paragraph", heading: null }] })) };
    });

    const { document, stakeholder_rationale } = await parseWithLlm({
      filename: "medical-notes.txt",
      buffer: Buffer.from(text),
      mime: "text/plain",
      ask,
    });

    expect(stakeholderAsks).toBe(2);
    expect(document.stakeholder_function).toBe("market_access");
    expect(stakeholder_rationale).toBe("Payer and HTA feedback.");
    expect(document.parser).toBe("llm");
  });
});

describe("parse routing", () => {
  let savedStub: string | undefined;
  beforeEach(() => {
    savedStub = process.env.SYNAPSE_TEST_STUB_LLM;
    delete process.env.SYNAPSE_TEST_STUB_LLM;
  });
  afterEach(() => {
    if (savedStub === undefined) delete process.env.SYNAPSE_TEST_STUB_LLM;
    else process.env.SYNAPSE_TEST_STUB_LLM = savedStub;
  });



  it("S1 throws without a connected LLM", async () => {
    const route = { stage: "S1", auth: "none", connected: false, reason: null } as unknown as ResolvedRoute;
    const ctx = {
      route,
      run: { id: "t", step: async (_name: string, fn: () => unknown) => fn(), note: () => {}, steps: () => [] },
      complete: async () => ({}),
    } as unknown as ModuleContext;
    await expect(s1ParseModule.run(s1ParseModule.inputSchema.parse({}), ctx)).rejects.toBeInstanceOf(NoRouteError);
  });
});
