import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/modules";
import { NoRouteError } from "@/modules/llm/provider";
import type { ModuleContext, ResolvedRoute } from "@/modules/kernel/contracts";
import { parseWithLlm, structureWithLlm, type RawUnit } from "@/lib/ingest/llm-structure";
import { resolveParsePolicy } from "@/accuracy/modules/parse/parse-policy";
import { parseModule as accuracyParseModule } from "@/accuracy/modules/parse/module";
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
  it("takes every block, kind and heading from the model and records dropped noise", async () => {
    const { ask, calls } = scripted((call) => ({ units: idsOf(call).map(good) }));
    const { blocks, dropped } = await structureWithLlm({ filename: "deck.pptx", units, ask });

    expect(calls).toHaveLength(1);
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["title", "Velmara evidence plan 2026"],
      ["heading", "Comparative evidence."],
      ["paragraph", "No head-to-head data versus osimertinib for the HTA dossier."],
    ]);
    expect(blocks[2]).toMatchObject({ heading: "Comparative evidence.", location: { ref: "Slide 2" } });
    expect(dropped).toEqual([{ location: "Slide 3", reason: "Confidentiality footer and page number." }]);
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

  it("never selects LlamaParse: every file type is parsed by the LLM", () => {
    for (const [filename, mime] of [
      ["plan.pdf", "application/pdf"],
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["notes.txt", "text/plain"],
    ] as const) {
      expect(resolveParsePolicy({ filename, mime }).parser).toBe("llm");
    }
  });

  it("the accuracy parse module throws without a connected LLM", async () => {
    const ctx = {
      route: { connected: false, auth: "none" },
      run: { step: async (_name: string, fn: () => unknown) => fn(), note: () => {} },
    } as unknown as Parameters<typeof accuracyParseModule.run>[1];
    await expect(
      accuracyParseModule.run(
        {
          workspace_id: "ws",
          source_file_id: "src",
          filename: "plan.pdf",
          mime: "application/pdf",
          content_base64: Buffer.from("%PDF").toString("base64"),
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(NoRouteError);
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


/** Reconciled coverage from the retired LlamaParse module/ingest suites. */
describe("Accuracy parse persistence through the current runner", () => {
  it("persists locally extracted stub blocks with tenant scope and zero model cost", async () => {
    const { registerAccuracyStack, runAccuracyModule } = await import("@/accuracy");
    const { createOrganization, createWorkspace, deleteWorkspace } = await import("@/accuracy/store/tenant");
    const { readParseBlocks } = await import("@/accuracy/store/parse-store");
    const org_id = await createOrganization("Reconciled parser test");
    const workspace_id = await createWorkspace({ org_id, name: "Parse persistence", slug: `parse-reconciled-${Date.now()}` });
    registerAccuracyStack();
    try {
      const result = await runAccuracyModule<{ parser: string; block_count: number }>({
        call_kind: "parse",
        input: { workspace_id, source_file_id: "src-reconciled", filename: "notes.txt", mime: "text/plain",
          content_base64: Buffer.from("Evidence plan overview\n\nRegistry gap for biomarker subgroup").toString("base64") },
        actor: { name: "test", function: "medical_affairs" }, org_id, workspace_id,
      });
      expect(result.output).toMatchObject({ parser: "local_structured", block_count: 2 });
      expect(result.cost_usd).toBe(0);
      const stored = await readParseBlocks(workspace_id, "src-reconciled");
      expect(stored).toHaveLength(2);
      expect(stored.map(block => block.text)).toEqual(["Evidence plan overview", "Registry gap for biomarker subgroup"]);
      expect(stored.every(block => block.parser === "local_structured")).toBe(true);
      expect(await readParseBlocks("other-workspace", "src-reconciled")).toEqual([]);
    } finally {
      await deleteWorkspace(workspace_id);
    }
  });

  it("maps parsed headings and paragraphs to store kinds and source locations", async () => {
    const { blocksFromParsedDocument } = await import("@/accuracy/store/parse-store");
    const rows = blocksFromParsedDocument({ workspace_id: "ws", source_file_id: "src", blocks: [
      { id: "b1", location: { ref: "p.1" }, text: "Evidence plan", kind: "title" },
      { id: "b2", location: { ref: "p.2" }, text: "Registry gap", kind: "paragraph" },
    ] });
    expect(rows.map(row => row.kind)).toEqual(["heading", "prose"]);
    expect(rows.map(row => row.heading)).toEqual(["p.1", "p.2"]);
    expect(rows.every(row => row.source_file_id === "src")).toBe(true);
  });

  it("uses the current LLM ingest outside the stub and propagates model errors", async () => {
    const { ingestFile } = await import("@/accuracy/modules/parse/ingest-file");
    vi.stubEnv("SYNAPSE_TEST_STUB_LLM", "0");
    try {
      const { ask } = scripted(call => call.purpose === "parse-stakeholder"
        ? { stakeholder_function: "medical_affairs", rationale: "Medical evidence need." }
        : { units: (call.body.units as { unit: string; text: string }[]).map(row => ({ unit: row.unit,
          blocks: [{ text: row.text, kind: "paragraph", heading: null }] })) });
      const args = { policy: resolveParsePolicy({ filename: "notes.txt", mime: "text/plain" }),
        filename: "notes.txt", mime: "text/plain", buffer: Buffer.from("Registry evidence is needed.") };
      const result = await ingestFile({ ...args, ask });
      expect(result.effectiveParser).toBe("llm");
      expect(result.document.blocks[0]?.text).toBe("Registry evidence is needed.");
      expect(result.stakeholder?.stakeholder_function).toBe("medical_affairs");
      await expect(ingestFile({ ...args, ask: async () => { throw new Error("Model unavailable"); } }))
        .rejects.toThrow("Model unavailable");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
