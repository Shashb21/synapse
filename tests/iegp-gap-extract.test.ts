import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeExtractInput } from "@/lib/iegp/extract/normalize";
import { runGapExtractionLoop } from "@/lib/iegp/extract/loop";
import { setGapExtractCompleter, assertGapExtractLlmReady } from "@/lib/iegp/extract/client";
import { hasAnthropicKey, anthropicWorkspaceId } from "@/lib/config";
import { DEMO_JSON_PACK, DEMO_PACK } from "@/lib/iegp/demo-pack";
import { allExtractTestDocuments, extractTestManifest } from "@/lib/iegp/demo-json";
import { startGapExtraction } from "@/lib/iegp/extract/orchestrate";
import { recordHumanGapFeedback } from "@/lib/iegp/extract/feedback";
import { runGapPromptHillclimb } from "@/lib/iegp/extract/hillclimb";
import {
  listGoldGaps,
  wipeExtractTables,
  championPromptVersion,
} from "@/lib/iegp/extract/store";
import { resetSeed, ingestJudgedExtraction, loadState } from "@/lib/iegp/store";
import { GAP_EXTRACT_ROUNDS } from "@/lib/iegp/extract/contracts";

const heorGap = {
  name: "Comparative effectiveness versus regional SoC in elderly patients",
  statement:
    "Need comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
  domain: "comparative_effectiveness",
  domain_rationale: "HTA elderly SoC question",
  source_quote:
    "We need to understand comparative effectiveness of Velmara versus regional standard of care in elderly patients.",
  source_location: "Elderly",
  needs: [
    {
      statement: "We don't have enough evidence in patients aged 65 and over.",
      source_quote: "Insufficient evidence in patients aged 65 and over remains an open question for HTA.",
    },
  ],
  pico: {
    population: "Patients aged 65+",
    intervention: "Velmara",
    comparator: "Regional SoC",
    outcome: "Comparative effectiveness",
    geography: "EU5",
    timing: "HTA",
  },
};

function mockCompleter() {
  return async (args: { system: string; user: string }) => {
    if (args.system.includes("You are the critic")) {
      return {
        findings: [
          {
            kind: "partial",
            gap_name: heorGap.name,
            statement: heorGap.statement,
            rationale: "Could split economic burden as a second gap on a later round.",
          },
        ],
        summary: "Grounded elderly CE gap.",
      };
    }
    if (args.system.includes("You are the judge")) {
      return {
        decisions: [{ name: heorGap.name, action: "keep", rationale: "Atomic and grounded." }],
        gaps: [heorGap],
        needs: [],
        rationale: "Keep the elderly comparative-effectiveness gap.",
      };
    }
    if (args.system.includes("You are the improver")) {
      return {
        recommended_prompt_version: "v1.4-human-feedback",
        rationale: ["Humans rewrote titles — strengthen noun phrases."],
        prompt_patch: "HARD RULE: titles are noun phrases.",
        system_prompt: `${args.system}\n\nPatched for tests.`,
      };
    }
    return { gaps: [heorGap], needs: heorGap.needs, notes: ["mock proposer"] };
  };
}

afterEach(() => {
  setGapExtractCompleter(null);
});

describe("gap extract normalize", () => {
  it("prefers JSON blocks over markdown and falls back to markdown", () => {
    const json = normalizeExtractInput({
      format: "json",
      json: {
        title: "Parsed deck",
        filename: "deck.json",
        blocks: [
          {
            id: "b1",
            heading: "Elderly",
            text: "We need comparative effectiveness versus SoC in elderly patients.",
            location: { kind: "slide", ref: "4" },
            kind: "bullet",
          },
        ],
      },
    });
    expect(json.format).toBe("json");
    expect(json.blocks[0]?.location).toMatch(/slide 4/i);
    expect(json.blocks[0]?.kind).toBe("bullet");

    const md = normalizeExtractInput({
      markdown: DEMO_PACK[0]!.text,
      title: DEMO_PACK[0]!.title,
    });
    expect(md.format).toBe("markdown");
    expect(md.blocks.length).toBeGreaterThan(0);
  });

  it("normalizes every shipped JSON extract fixture with gold source_key", () => {
    const dir = join(process.cwd(), "public/demo-sources/json");
    const generated = allExtractTestDocuments();
    expect(generated.length).toBeGreaterThanOrEqual(8);
    for (const doc of generated) {
      const onDisk = JSON.parse(readFileSync(join(dir, doc.filename), "utf8")) as typeof doc;
      expect(onDisk).toEqual(doc);
      const source = normalizeExtractInput({ format: "json", json: onDisk, title: doc.title });
      expect(source.blocks.length).toBeGreaterThan(0);
      expect(onDisk.source_key).toBeTruthy();
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      docs: { filename: string }[];
    };
    expect(manifest.docs).toHaveLength(DEMO_JSON_PACK.length);
    expect(extractTestManifest().docs.map((d) => d.filename)).toEqual(
      manifest.docs.map((d) => d.filename),
    );
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBeGreaterThanOrEqual(9);
  });

  it("reads LlamaParse-shaped JSON including chart-like items", () => {
    const source = normalizeExtractInput({
      json: {
        markdown_full: "# Slide 1\n\nLimited evidence on CNS response.",
        items: [{ page: 1, items: [{ type: "chart", heading: "CNS", value: "ORR 12%" }] }],
      },
      title: "KOL deck",
    });
    expect(source.blocks.some((b) => /CNS|ORR|Limited evidence/i.test(b.text))).toBe(true);
  });
});

describe("gap extract agents", () => {
  it("throws when the LLM key is missing and no completer is injected", () => {
    const prev = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_KEY: process.env.ANTHROPIC_KEY,
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_KEY;
    delete process.env.CLAUDE_API_KEY;
    setGapExtractCompleter(null);
    try {
      expect(() => assertGapExtractLlmReady()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev.ANTHROPIC_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
      if (prev.ANTHROPIC_KEY !== undefined) process.env.ANTHROPIC_KEY = prev.ANTHROPIC_KEY;
      if (prev.CLAUDE_API_KEY !== undefined) process.env.CLAUDE_API_KEY = prev.CLAUDE_API_KEY;
    }
  });

  it("accepts ANTHROPIC_KEY as the same live extract key", () => {
    const prevA = process.env.ANTHROPIC_API_KEY;
    const prevB = process.env.ANTHROPIC_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_KEY = "test-not-a-real-key";
    try {
      expect(hasAnthropicKey()).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_KEY;
      if (prevA !== undefined) process.env.ANTHROPIC_API_KEY = prevA;
      if (prevB !== undefined) process.env.ANTHROPIC_KEY = prevB;
    }
  });

  it("reads ANTHROPIC_WORKSPACE_ID for identity-linked keys", () => {
    const prev = process.env.ANTHROPIC_WORKSPACE_ID;
    process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_test";
    try {
      expect(anthropicWorkspaceId()).toBe("wrkspc_test");
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_WORKSPACE_ID = prev;
      else delete process.env.ANTHROPIC_WORKSPACE_ID;
    }
  });

  it("runs three propose-critique rounds then a judge", async () => {
    setGapExtractCompleter(mockCompleter());
    const source = normalizeExtractInput({
      markdown: DEMO_PACK[0]!.text,
      title: DEMO_PACK[0]!.title,
    });
    const result = await runGapExtractionLoop({ source });
    expect(result.rounds).toHaveLength(GAP_EXTRACT_ROUNDS);
    expect(result.gaps[0]?.name).toMatch(/comparative effectiveness/i);
    expect(result.gaps[0]?.pico?.population).toMatch(/65/);
    expect(result.judge.decisions[0]?.action).toBe("keep");
  });
});

describe("gap extract persist and feedback", () => {
  it("persists judged gaps as live Open rows with PICO metadata and joins restatements", async () => {
    await resetSeed();
    setGapExtractCompleter(mockCompleter());
    const source = normalizeExtractInput({
      markdown: DEMO_PACK[0]!.text,
      title: DEMO_PACK[0]!.title,
      filename: DEMO_PACK[0]!.filename,
    });
    const first = await ingestJudgedExtraction({
      title: source.title,
      filename: source.filename,
      source_type: "stakeholder_interview",
      stakeholder_function: "heor",
      text: source.full_text,
      blocks: source.blocks,
      gaps: [heorGap],
      needs: [],
      actor_name: "A. Rao",
      actor_function: "heor",
      extract_run_id: "XRUN-test",
      prompt_version: "v1.3-cross-source",
      source_key: "heor-interview",
    });
    expect(first.createdGapIds.length).toBe(1);
    const second = await ingestJudgedExtraction({
      title: "TLR restates elderly CE",
      source_type: "targeted_literature_review",
      stakeholder_function: "heor",
      text: "Evidence gap on comparative effectiveness in the elderly is not closed.",
      blocks: [
        {
          heading: "Elderly",
          text: "Evidence gap on comparative effectiveness in the elderly is not closed.",
          location: "TLR",
        },
      ],
      gaps: [
        {
          ...heorGap,
          source_quote: "Evidence gap on comparative effectiveness in the elderly is not closed.",
        },
      ],
      needs: [],
      actor_name: "A. Rao",
      actor_function: "heor",
      source_key: "tlr",
    });
    expect(second.createdGapIds.length).toBe(0);
    expect(second.mergedGapIds).toContain(first.createdGapIds[0]);
    const state = await loadState();
    const gap = state.gaps.find((g) => g.id === first.createdGapIds[0])!;
    expect(gap.retired).toBe(false);
    expect(gap.status).not.toBe("excluded");
    expect(gap.human_validated).toBe(false);
    const observed = (gap.metadata?.observed_in as { source_title?: string }[]) ?? [];
    expect(observed.length).toBeGreaterThanOrEqual(2);
    const pico = gap.metadata?.pico as { population?: string } | undefined;
    expect(pico?.population).toMatch(/65/);
  });

  it("records human wording edits into gold", async () => {
    await resetSeed();
    await wipeExtractTables();
    await recordHumanGapFeedback({
      gap_id: "GAP-TEST",
      kind: "wording",
      before: { name: "We need elderly data", statement: "We need elderly data." },
      after: {
        name: "Comparative effectiveness versus regional SoC in elderly patients",
        statement: "Need comparative effectiveness versus regional SoC in elderly patients.",
      },
      actor_name: "A. Rao",
      actor_function: "heor",
      source_key: "heor-interview",
    });
    const gold = await listGoldGaps();
    expect(gold.some((g) => g.origin === "human_wording" && /comparative effectiveness/i.test(g.name))).toBe(
      true,
    );
  });
});

describe("gap extract API orchestration", () => {
  it("dry-runs an extract with wait and stores a completed run tape", async () => {
    setGapExtractCompleter(mockCompleter());
    const out = await startGapExtraction({
      format: "markdown",
      markdown: DEMO_PACK[0]!.text,
      title: DEMO_PACK[0]!.title,
      persist: false,
      wait: true,
      actor_name: "A. Rao",
      actor_function: "heor",
    });
    expect(out.status).toBe("completed");
    expect(out.run?.status).toBe("completed");
    const result = out.run?.result as { gaps?: { name: string }[] };
    expect(result.gaps?.[0]?.name).toMatch(/comparative/i);
  });

  it("hill-climbs prompt versions against gold with a mocked LLM", async () => {
    setGapExtractCompleter(mockCompleter());
    const hill = await runGapPromptHillclimb({
      actor_name: "A. Rao",
      actor_function: "heor",
      trigger: "test",
    });
    expect(hill.champion).toBeTruthy();
    expect(await championPromptVersion()).toBe(hill.champion);
  });
});
