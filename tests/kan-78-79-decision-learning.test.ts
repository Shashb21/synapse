import { RunRecorder, openRun, closeRun } from "@/modules/kernel/observability";
import * as routing from "@/modules/kernel/routing";
import { loadState, persistState } from "@/lib/iegp/store";
import { getWorkspace } from "@/modules/workspaces/store";
import { runInWorkspace } from "@/modules/workspaces/context";
import { createWorkspace, setLearningSharingEligible } from "@/modules/workspaces/store";
import { describe, expect, it, vi } from "vitest";
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
  captureResidualDecision,
} from "@/lib/iegp/learning-capture";
import type { GapSuggestion } from "@/lib/iegp/types";

/**
 * KAN-78/79: people's decisions on AI output become examples. Runs see similar
 * past cases as worked examples, never as rules, and raw customer text never
 * reaches another workspace's prompt.
 */

const unique = () => `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;

async function provideEntityContext(id: string) {
  const ws = (await getWorkspace(id))!;
  await runInWorkspace({ workspace_id: id, schema: ws.schema_name }, async () => {
    const state = await loadState(); state.asset.name = "Examplebrand"; await persistState(state);
  });
}

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
    const a = (await createWorkspace({ name: `wsA-${unique()}`, owner: "learning-test" })).id;
    const b = (await createWorkspace({ name: `wsB-${unique()}`, owner: "learning-test" })).id;
    await provideEntityContext(a);
    await setLearningSharingEligible(a, true);
    await setLearningSharingEligible(b, true);
    const secret = `ZELVORA${unique().slice(-4).toUpperCase()}`;
    const statement = `${secret} corneal toxicity management in elderly patients is undocumented in routine practice`;
    const okId = await example(a, statement, `${secret}-ok`);
    const failedId = await example(a, statement, `${secret}-failed`);
    await example(a, statement, `${secret}-pending`);
    await setLesson(okId, "When a source adds a narrower population to a management gap, reviewers keep it separate.", "ok");
    await setLesson(failedId, `Reviewers kept the ${secret} population separate.`, "failed");

    const query = "narrower population management";
    const forB = await similarExamples({ stage: "S2", kinds: ["gap_suggestion"], text: query, workspace_id: b, allow_cross_workspace: true });
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
    await setLearningSharingEligible(a, false);
    await setLearningSharingEligible(b, false);
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
    const ws = (await createWorkspace({ name: `wsL-${unique()}`, owner: "learning-test" })).id;
    await provideEntityContext(ws);
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
    const workspace = await createWorkspace({ name: `wsD-${unique()}`, owner: "learning-test" });
    const ws = workspace.id;
    const recorder = new RunRecorder({ workspace_id: ws, stage: "S8", module_id: "s8.test", module_version: "test", actor: { name: "Test", function: "medical_affairs" }, input: {} });
    await runInWorkspace({ workspace_id: ws, schema: workspace.schema_name }, async () => {
      await openRun(recorder); await closeRun({ recorder, status: "ok", output: { placements: [] } });
    });
    const proposal = { id: `PROP-${unique()}`, name: "MAIC", type: "maic", evidence_question: "q", rationale: "r" };
    await captureProposalDecision({ proposal, gap: null, decision: "accept", final: { ...proposal, name: "Anchored MAIC" }, rationale: "better", workspace_id: ws });
    await captureMappingRowDecision({
      gap: { id: `GAP-${unique()}`, name: "g", statement: "s" },
      ai: { mapping_status: "addressed", tactic_ids: ["TAC-1"] },
      saved: { mapping_status: "addressed", tactic_ids: ["TAC-1"] },
      rationale: "right",
      workspace_id: ws,
    });
    await captureBandDecision({ run_id: recorder.id, gap: { id: `GAP-${unique()}`, name: "g", statement: "s" }, suggested_band: "high", band: "medium", rationale: "less urgent", workspace_id: ws });
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
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});


describe("decision originating provenance", () => {
  it("records one example per shared decision, carries available lineage and excludes unreplayable history", async () => {
    const workspace = await createWorkspace({ name: `provenance-${unique()}`, owner: "learning-test" });
    const ws = workspace.id;
    const actor = { name: "Review Test", function: "medical_affairs" as const };
    const origin = { workspace_id: ws, actor, run_id: `originating-${unique()}`, prompt_version: "original-prompt" };
    await runInWorkspace({ workspace_id: ws, schema: workspace.schema_name }, async () => {
      const recorder = new RunRecorder({ workspace_id: ws, stage: "S6", module_id: "s6.test", module_version: "test", actor, input: { gap_id: "original-gap" } }, origin.run_id);
      await openRun(recorder); await closeRun({ recorder, status: "ok", output: { proposal: { open_statement: "Leftover question" } }, route: {
        stage: "S6", provider_id: "original-provider", provider_label: "Original route", model: "original-model", auth: "none", connected: false,
        params: { temperature: 0, max_tokens: 1000 }, fallbacks: [], degraded: false, reason: null,
      } });
    });
    const bandRunId = `${origin.run_id}-band`;
    await runInWorkspace({ workspace_id: ws, schema: workspace.schema_name }, async () => {
      const recorder = new RunRecorder({ workspace_id: ws, stage: "S8", module_id: "s8.test", module_version: "test", actor, input: {} }, bandRunId);
      await openRun(recorder); await closeRun({ recorder, status: "ok", output: { placements: [] } });
    });
    const gap = { id: `GAP-${unique()}`, name: "gap", statement: "gap statement" };
    const overlap = suggestion();
    await captureGapSuggestionDecision({ ...origin, suggestion: overlap, gap, decision: "split", rationale: "Keep separate" });
    await captureGapSuggestionDecision({ ...origin, suggestion: overlap, gap, decision: "split", rationale: "Keep separate" });
    await captureMappingRowDecision({ ...origin, gap, ai: { mapping_status: "open", tactic_ids: [] }, saved: { mapping_status: "open", tactic_ids: [] }, rationale: "Agree with result" });
    await captureBandDecision({ ...origin, run_id: bandRunId, gap, suggested_band: "high", band: "low", rationale: "Lower urgency" });
    const idea = { id: `IDEA-${unique()}`, name: "study", type: "rwe", evidence_question: "question", rationale: "reason", design: { population: "adults" } };
    await captureProposalDecision({ ...origin, proposal: idea, gap, decision: "accept", final: { ...idea, design: { population: "older adults" } }, rationale: "Narrower design" });
    await captureResidualDecision({ ...origin, parent_gap_id: gap.id, proposed: "Leftover question", final: null, decision: "reject", rationale: "Already answered" });
    const rows = (await sharedDb().execute(sql`select * from decision_examples where workspace_id = ${ws} order by kind`)) as unknown as { id: string; kind: string; outcome: string; actor: unknown; run_id: string; prompt_version: string }[];
    expect(rows.map(row => [row.kind, row.outcome])).toEqual([
      ["gap_suggestion", "accepted"], ["residual_split", "rejected"], ["s4_mapping", "accepted"], ["s8_band", "edited"], ["s9_proposal", "edited"],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ actor, run_id: row.kind === "s8_band" ? bandRunId : origin.run_id, prompt_version: "original-prompt" });
      const saved = (await getDecisionExample(row.id))!;
      if (row.kind === "residual_split") expect(saved).toMatchObject({ model: "original-model", provider_id: "original-provider" });
      expect(saved.replay_input).toBeNull(); expect(saved.replay_exclusion_reason).toMatch(/frozen originating/);
    }
  });

  it("retains a supplied frozen replay payload and does not replace missing origin with today's route", async () => {
    const configuredRoute = vi.spyOn(routing, "resolveRoute");
    const replay = { stage_input: { gap_ids: ["GAP-test"] }, context: { gaps: [{ id: "GAP-test", statement: "Original question" }] } };
    const id = await recordDecisionExample({ workspace_id: "unknown-origin-workspace", stage: "S8", kind: "s8_band", subject_id: unique(), ai_input: {}, ai_output: { band: "high" }, outcome: "accepted", replay_input: replay });
    const saved = (await getDecisionExample(id!))!;
    expect(saved.replay_input).toEqual(replay); expect(saved.replay_exclusion_reason).toBeNull();
    expect(saved.model).toBeNull(); expect(saved.provider_id).toBeNull(); expect(saved.run_id).toBeNull(); expect(saved.prompt_version).toBeNull();
    expect(configuredRoute).not.toHaveBeenCalled(); configuredRoute.mockRestore();
  });
});


describe("residual learning requires AI lineage", () => {
  it("skips a human-only residual draft and an unavailable originating run", async () => {
    const ws = `manual-${unique()}`;
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const args = { workspace_id: ws, parent_gap_id: "manual-gap", proposed: "A human wrote this draft", final: "A human wrote this draft", decision: "accept" as const, rationale: "Keep my draft" };
    await captureResidualDecision(args); await captureResidualDecision({ ...args, run_id: "missing-run" });
    const rows = await sharedDb().execute(sql`select id from decision_examples where workspace_id = ${ws}`);
    expect(rows).toHaveLength(0); expect(logged).toHaveBeenCalled(); logged.mockRestore();
  });
});

describe("distinct human decision events", () => {
  it("coalesces the same event while preserving identical content from different events", async () => {
    const ws = `events-${unique()}`;
    const draft = { workspace_id: ws, stage: "S4" as const, kind: "s4_mapping" as const, subject_id: "event-gap", ai_input: {}, ai_output: {}, outcome: "accepted" as const };
    await recordDecisionExample({ ...draft, capture_key: "edit-first" });
    await recordDecisionExample({ ...draft, capture_key: "edit-first" });
    await recordDecisionExample({ ...draft, capture_key: "edit-second" });
    await recordDecisionExample(draft); await recordDecisionExample(draft);
    const rows = await sharedDb().execute(sql`select id from decision_examples where workspace_id = ${ws}`);
    expect(rows).toHaveLength(4);
  });

  it("skips manual S8 validation but retains every actual model validation event", async () => {
    const { createGap } = await import("@/lib/iegp/store");
    const { setPlacement, validatePlacement } = await import("@/modules/stages/s8-prioritization/module");
    const workspace = await createWorkspace({ name: `s8-events-${unique()}`, owner: "learning-test" });
    const actor = { name: "Band reviewer", function: "medical_affairs" as const };
    await runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, async () => {
      const gap = await createGap({ statement: "Unanswered evidence question", actor_name: actor.name, actor_function: actor.function });
      await setPlacement({ gap_id: gap, band: "high", rationale: "Manual placement", actor });
      await validatePlacement({ gap_id: gap, band: "high", rationale: "Manual validation", actor });
      expect(await sharedDb().execute(sql`select id from decision_examples where workspace_id = ${workspace.id}`)).toHaveLength(0);
      const recorder = new RunRecorder({ workspace_id: workspace.id, stage: "S8", module_id: "s8.test", module_version: "test", actor, input: { gap_ids: [gap] } });
      await openRun(recorder); await closeRun({ recorder, status: "ok", output: { placements: [{ gap_id: gap, suggested_band: "high" }] } });
      const { db } = await import("@/modules/kernel/db");
      await db().execute(sql`update priority_placements set run_id = ${recorder.id}, suggested_band = 'high', suggested_rationale = 'Model explanation' where gap_id = ${gap}`);
      await validatePlacement({ gap_id: gap, band: "high", rationale: "Model validation", actor });
      await validatePlacement({ gap_id: gap, band: "high", rationale: "Model validation", actor });
      const rows = await sharedDb().execute(sql`select outcome, run_id from decision_examples where workspace_id = ${workspace.id}`);
      expect(rows).toHaveLength(2); expect(rows).toEqual(expect.arrayContaining([{ outcome: "accepted", run_id: recorder.id }]));
    });
  });

  it("records a subsequent genuine S9 decision after restoring a rejected proposal", async () => {
    const { decideIdeationProposal, restoreIdeationProposal } = await import("@/modules/stages/s9-ideation/module");
    const { db, ensurePlatformSchema } = await import("@/modules/kernel/db");
    const { ideationProposals } = await import("@/modules/kernel/schema");
    const workspace = await createWorkspace({ name: `s9-events-${unique()}`, owner: "learning-test" });
    const actor = { name: "Idea reviewer", function: "medical_affairs" as const };
    await runInWorkspace({ workspace_id: workspace.id, schema: workspace.schema_name }, async () => {
      await ensurePlatformSchema(); const id = `IDEA-${unique()}`;
      await db().insert(ideationProposals).values({ id, gap_id: "original-gap", name: "AI idea", type: "rwe_study", rationale: "AI rationale", evidence_question: "Question", design: { origin: "ai" }, created_at: new Date().toISOString() });
      const decision = { id, decision: "reject" as const, rationale: "Not appropriate", actor, workspace_id: workspace.id };
      await decideIdeationProposal(decision); await restoreIdeationProposal({ id, rationale: "Reconsider the idea", actor }); await decideIdeationProposal(decision);
      expect(await sharedDb().execute(sql`select id from decision_examples where workspace_id = ${workspace.id} and subject_id = ${id}`)).toHaveLength(2);
    });
  });
});
