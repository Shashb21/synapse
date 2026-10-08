import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { sharedDb } from "@/modules/kernel/db";
import {
  computeLesson,
  getDecisionExample,
  rankBySimilarity,
  recordDecisionExample,
  scrubLesson,
  similarExamples,
  workedExamplesAsPrompt,
} from "@/modules/kernel/decision-examples";
import {
  captureBandDecision,
  captureGapSuggestionDecision,
  captureMappingRowDecision,
  captureProposalDecision,
} from "@/lib/iegp/learning-capture";
import type { GapSuggestion } from "@/lib/iegp/types";

/**
 * KAN-78/79: people's decisions on AI output become examples. Runs see similar
 * past cases as worked examples, never as rules, and raw customer text never
 * reaches another workspace's prompt.
 */

const unique = () => `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;

async function setLesson(id: string, lesson: string, status: "ok" | "failed") {
  await sharedDb().execute(sql`update decision_examples set lesson = ${lesson}, lesson_status = ${status} where id = ${id}`);
}

async function example(workspace_id: string, statement: string, marker: string) {
  const id = await recordDecisionExample({
    workspace_id,
    stage: "S2",
    kind: "gap_suggestion",
    subject_id: `GSUG-${marker}`,
    ai_input: { existing_gap: { name: "Corneal toxicity management", statement }, candidate: { name: marker, statement } },
    ai_output: { verdict: "overlaps", merged: { name: "x", statement: "y" } },
    outcome: "edited",
    final: { decision: "split", name: `${marker} split` },
    rationale: `Keep ${marker} separate`,
  });
  expect(id).toBeTruthy();
  return id!;
}

function suggestion(overrides: Partial<GapSuggestion> = {}): GapSuggestion {
  return {
    id: `GSUG-${unique()}`,
    gap_id: "GAP-003",
    run_id: "run-test",
    candidate_row_id: null,
    source_id: "SRC-1",
    name: "Corneal toxicity in patients 75+",
    statement: "Corneal toxicity management in patients aged 75 and over is undocumented.",
    domain: "safety",
    source_quote: "q",
    shared_part: "Corneal toxicity management.",
    new_part: "Patients aged 75 and over.",
    merged_name: "Corneal toxicity management incl. 75+",
    merged_statement: "Corneal toxicity management lacks data, including in patients aged 75 and over.",
    split_name: "Corneal toxicity in patients 75+",
    split_statement: "Corneal toxicity management in patients aged 75 and over is undocumented.",
    extra_sources: [],
    status: "pending",
    result_gap_id: null,
    decided_by: null,
    rationale: null,
    created_at: new Date().toISOString(),
    decided_at: null,
    ...overrides,
  };
}

describe("KAN-79 worked examples never leak raw text across workspaces", () => {
  it("shows own cases verbatim, other workspaces only as scrubbed lessons, and never failed or pending ones", async () => {
    const a = `wsA-${unique()}`;
    const b = `wsB-${unique()}`;
    const secret = `ZELVORA${unique().slice(-4).toUpperCase()}`;
    const statement = `${secret} corneal toxicity management in elderly patients is undocumented in routine practice`;
    const okId = await example(a, statement, `${secret}-ok`);
    const failedId = await example(a, statement, `${secret}-failed`);
    await example(a, statement, `${secret}-pending`);
    await setLesson(okId, "When a source adds a narrower population to a management gap, reviewers keep it separate.", "ok");
    await setLesson(failedId, `Reviewers kept the ${secret} population separate.`, "failed");

    const query = "corneal toxicity management in elderly patients routine practice";
    const forB = await similarExamples({ stage: "S2", kinds: ["gap_suggestion"], text: query, workspace_id: b });
    const promptB = workedExamplesAsPrompt(forB);
    expect(forB.map((row) => row.id)).toContain(okId);
    expect(forB.map((row) => row.id)).not.toContain(failedId);
    expect(forB.every((row) => row.scope === "other_plans")).toBe(true);
    expect(promptB).not.toContain(secret);
    expect(promptB).toContain("narrower population");
    expect(promptB).toContain("examples, not rules");

    const forA = await similarExamples({ stage: "S2", kinds: ["gap_suggestion"], text: query, workspace_id: a });
    expect(forA[0]!.scope).toBe("this_plan");
    expect(workedExamplesAsPrompt(forA)).toContain(secret);
  });

  it("no stage prompt carries the old 'Reviewer corrections… Respect them' rules", () => {
    const roots = ["src/modules/stages", "src/modules/kernel"];
    const files = roots.flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join(root, file)),
    );
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/Respect them/);
      expect(text, file).not.toMatch(/reviewer_corrections/);
    }
  });
});

describe("KAN-79 similarity ranking", () => {
  it("ranks the case that shares rare words above an unrelated one", () => {
    const items = [
      { id: "unrelated", text: "budget impact model for payer submission costs" },
      { id: "related", text: "corneal toxicity keratopathy management ophthalmology referral" },
      { id: "partial", text: "management of hyperphosphatemia in community practice" },
    ];
    const ranked = rankBySimilarity("keratopathy corneal toxicity in older patients", items, (item) => item.text);
    expect(ranked[0]!.item.id).toBe("related");
    expect(ranked.map((row) => row.item.id)).not.toContain("unrelated");
  });
});

describe("KAN-78 de-identified lessons", () => {
  const raw = ['{"name":"ZEPHYR-RWE registry","statement":"Zelvora (zelmotinib) for Corvantix in the UK"}'];
  it("passes a general lesson and refuses names, numbers, quotes and drug stems", () => {
    expect(scrubLesson("Reviewers split a narrower patient population into its own gap.", raw, ["Zelvora", "Corvantix"])).toBe(
      "Reviewers split a narrower patient population into its own gap.",
    );
    expect(scrubLesson("Reviewers kept Zelvora data separate.", raw, ["Zelvora"])).toBeNull();
    expect(scrubLesson("Reviewers kept the corvantix plan separate.", raw, ["Corvantix"])).toBeNull();
    expect(scrubLesson("Reviewers split patients aged 75 and over.", raw, [])).toBeNull();
    expect(scrubLesson('Reviewers said "keep it".', raw, [])).toBeNull();
    expect(scrubLesson("Reviewers kept the zelmotinib question separate.", raw, [])).toBeNull();
    expect(scrubLesson("The registry was mapped as the ZEPHYR-RWE source.", raw, [])).toBeNull();
  });

  it("computes a lesson with an injected model and refuses one that names the product", async () => {
    const ws = `wsL-${unique()}`;
    const good = await example(ws, "corneal toxicity management", `L${unique()}`);
    expect(await computeLesson(good, async () => ({ lesson: "Reviewers keep a narrower population as a separate gap." }))).toBe("ok");
    expect((await getDecisionExample(good))!.lesson_status).toBe("ok");
    const bad = await example(ws, "Zelvora corneal toxicity management", `B${unique()}`);
    expect(await computeLesson(bad, async () => ({ lesson: "Reviewers kept Zelvora separate." }))).toBe("failed");
    expect((await getDecisionExample(bad))!.lesson).toBeNull();
  });
});

describe("KAN-78 decision capture", () => {
  it("records merge, split and reject on a gap suggestion, with edited vs accepted", async () => {
    const ws = `wsC-${unique()}`;
    const merged = suggestion();
    await captureGapSuggestionDecision({ suggestion: merged, gap: { name: "g", statement: "s" }, decision: "merge", rationale: "one gap", workspace_id: ws });
    const split = suggestion();
    await captureGapSuggestionDecision({
      suggestion: split,
      gap: { name: "g", statement: "s" },
      decision: "split",
      name: "Edited name",
      rationale: "separate",
      workspace_id: ws,
    });
    const rejected = suggestion();
    await captureGapSuggestionDecision({ suggestion: rejected, gap: null, decision: "reject", rationale: "no", workspace_id: ws });
    const rows = (await sharedDb().execute(
      sql`select subject_id, outcome, final from decision_examples where workspace_id = ${ws}`,
    )) as unknown as { subject_id: string; outcome: string; final: { decision: string } }[];
    const by = new Map(rows.map((row) => [row.subject_id, row]));
    expect(by.get(merged.id)).toMatchObject({ outcome: "accepted", final: { decision: "merge" } });
    expect(by.get(split.id)).toMatchObject({ outcome: "edited", final: { decision: "split" } });
    expect(by.get(rejected.id)).toMatchObject({ outcome: "rejected" });
  });

  it("records S9, S4 and S8 decisions relative to the AI's proposal", async () => {
    const ws = `wsD-${unique()}`;
    const proposal = { id: `PROP-${unique()}`, name: "MAIC", type: "maic", evidence_question: "q", rationale: "r" };
    await captureProposalDecision({ proposal, gap: null, decision: "accept", final: { ...proposal, name: "Anchored MAIC" }, rationale: "better", workspace_id: ws });
    await captureMappingRowDecision({
      gap: { id: `GAP-${unique()}`, name: "g", statement: "s" },
      ai: { mapping_status: "addressed", tactic_ids: ["TAC-1"] },
      saved: { mapping_status: "addressed", tactic_ids: ["TAC-1"] },
      rationale: "right",
      workspace_id: ws,
    });
    await captureBandDecision({ gap: { id: `GAP-${unique()}`, name: "g", statement: "s" }, suggested_band: "high", band: "medium", rationale: "less urgent", workspace_id: ws });
    const rows = (await sharedDb().execute(
      sql`select kind, outcome from decision_examples where workspace_id = ${ws} order by kind`,
    )) as unknown as { kind: string; outcome: string }[];
    expect(rows).toEqual([
      { kind: "s4_mapping", outcome: "accepted" },
      { kind: "s8_band", outcome: "edited" },
      { kind: "s9_proposal", outcome: "edited" },
    ]);
  });

  it("never fails the person's action when the example cannot be written", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      recordDecisionExample({ stage: "S2", kind: "gap_suggestion", subject_id: "x", ai_input: circular, ai_output: {}, outcome: "accepted" }),
    ).resolves.toBeNull();
    const broken = suggestion({ merged_name: undefined as unknown as string });
    Object.defineProperty(broken, "name", { get: () => { throw new Error("boom"); } });
    await expect(
      captureGapSuggestionDecision({ suggestion: broken, gap: null, decision: "merge", rationale: "r" }),
    ).resolves.toBeUndefined();
  });
});
