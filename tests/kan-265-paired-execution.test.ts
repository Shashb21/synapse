import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { IegpState } from "@/lib/iegp/types";
import { buildBlankWorkspace } from "@/lib/iegp/blank";
import { frozenPriorityReviewHash, priorityReviewHash } from "@/modules/stages/s8-prioritization/review-basis";
import { DEFAULT_AXES } from "@/modules/stages/s8-prioritization/axes";
import * as attempts from "@/modules/kernel/revision-attempts";
import * as db from "@/modules/kernel/db";
import * as routing from "@/modules/kernel/routing";
import * as revisions from "@/modules/kernel/prompt-revisions";
import * as registry from "@/modules/kernel/registry";
import * as approvedRoutes from "@/modules/kernel/approved-evaluation-route";
import * as workspaces from "@/modules/workspaces/store";
import * as observability from "@/modules/kernel/observability";
import * as ai from "@/modules/kernel/ai-switch";
import * as llm from "@/modules/kernel/llm";
import * as learning from "@/modules/kernel/decision-examples";
import { runAgenticCycle } from "@/modules/kernel/agentic";
import { evidenceHash } from "@/modules/kernel/decision-replay";
import { evaluatePromptRevision, promotionEligibility } from "@/modules/kernel/prompt-revision-evals";
import type { ResolvedRoute, SynapseModule } from "@/modules/kernel/contracts";
import { inEvaluationIsolation } from "@/modules/kernel/evaluation-isolation";
import { targetMetrics, executionLineage, lineageGroups } from "@/modules/kernel/revision-policy";
const route: ResolvedRoute = {
  stage: "S8",
  provider_id: "fixture-script",
  provider_label: "test",
  model: "fiction",
  params: { temperature: 0, max_tokens: 2000 },
  connected: true,
  auth: "api_key",
  degraded: false,
  fallbacks: [],
  reason: null,
};
const actor = { name: "Fictional owner", function: "medical_affairs" as const };
function row(i: number): learning.DecisionExample {
  const gap = {
    id: "gap-" + i,
    statement: "Independent panel question " + i,
    objective_id: "obj",
    status: "validated_open",
    computed_status: "validated_open",
    status_override: null,
    parked_at: null,
    retired: false,
    related_gap_ids: [],
    parent_gap_id: null,
    origin_gap_id: null,
  };
  const snapshot = {
    version: 1,
    execution: "routed",
    workspace_id: "fiction",
    stage: "S8",
    run_id: "run-" + i,
    module_id: "fiction-stage",
    module_version: "1",
    prompt_version: "v1.0-baseline",
    route,
    input: { gap_ids: [gap.id] },
    facts: {
      axesConfig: { ...DEFAULT_AXES, updated_by: "fixture", updated_at: "2026-01-01" },
      state: {
        ...buildBlankWorkspace(),
        objectives: [{ id: "obj", name: "Fictional review", evidence_needed_by: "2028-07-01" }],
        gaps: [gap],
        needs: [
          {
            id: "need-" + i,
            source_id: "SRC-PLAN-ENTRY",
            statement: gap.statement,
            source_quote: gap.statement,
            run_id: null,
          },
        ],
        need_gap_links: [{ gap_id: gap.id, need_id: "need-" + i, role: "primary" }],
        sources: [{ id: "SRC-PLAN-ENTRY", full_text: "Administrative manual plan entries" }],
        gap_versions: [],
      },
    },
    examples: [],
  };
  return {
    id: "example-" + i,
    stage: "S8",
    workspace_id: "fiction",
    kind: "s8_band",
    subject_id: gap.id,
    actor_principal: "reviewer-" + i,
    run_id: snapshot.run_id,
    replay_input: snapshot,
    prompt_version: snapshot.prompt_version,
    model: route.model,
    provider_id: route.provider_id,
    priority_review_hash: frozenPriorityReviewHash(snapshot, gap.id),
    ai_input: { gap },
    ai_output: { band: "high" },
    outcome: "edited",
    final: { band: "low" },
    lesson: "reviewed " + i,
    lesson_status: "ok",
    created_at: "2026-11-0" + i,
    rationale: null,
  };
}
it("requires the confirmed priority context and axis pair to match the frozen run", () => {
  const example = row(1);
  expect(targetMetrics(example)).toEqual(["band_agreement"]);
  expect(targetMetrics({ ...example, priority_review_hash: null })).toEqual([]);
  const frozen = structuredClone(example.replay_input!);
  const facts = frozen.facts as { state: IegpState; axesConfig: typeof DEFAULT_AXES };
  const matrix = { x_axis: "decision_impact", y_axis: "time_pressure" };
  const pair = facts.axesConfig.axes.slice(0, 2);
  expect(priorityReviewHash(facts.state, facts.axesConfig, example.subject_id, { ...matrix, displayed_axes: pair })).toBe(example.priority_review_hash);
  expect(priorityReviewHash(facts.state, facts.axesConfig, example.subject_id, { ...matrix, displayed_axes: [{ ...pair[0], label: "Old definition" }, pair[1]] })).toBeNull();
  facts.state.objectives[0]!.evidence_needed_by = "2028-05-01";
  expect(targetMetrics({ ...example, replay_input: frozen })).toEqual([]);
  facts.state.objectives[0]!.evidence_needed_by = "2028-07-01";
  facts.state.gaps[0]!.priority_context_version = "later-objective-deadline";
  expect(targetMetrics({ ...example, replay_input: frozen })).toEqual([]);
  expect(targetMetrics({ ...example, replay_input: { ...example.replay_input, input: { x_axis: "feasibility", y_axis: "time_pressure" } } })).toEqual([]);
});

it("requires a changed human-authored target and reviewer identity", () => {
  const example = row(1);
  expect(targetMetrics(example)).toEqual(["band_agreement"]);
  for (const patch of [
    { outcome: "accepted" },
    { actor_principal: null },
    { actor_principal: "anonymous" },
    { actor_principal: "demo:user" },
    { final: { band: "high" } },
    { final: { band: "unknown" } },
  ]) {
    expect(targetMetrics({ ...example, ...patch } as learning.DecisionExample)).toEqual([]);
  }
});

const args = { workspace_id: "fiction", stage: "S8" as const, exclude_ids: [] };
const approved = { route, module_id: "fiction-stage", module_version: "1", generation: 0, parent: "v1.0-baseline" };
function fixture() {
  const examples = [1, 2, 3, 4, 5].map(row);
  const cohort = revisions.selectRevisionCohort(args, examples, approved);
  const revision = {
    id: "candidate",
    stage: "S8",
    workspace_id: "fiction",
    parent_revision: approved.parent,
    instruction_text: "Use corrected rule",
    cohort_id: cohort.id,
    generation_run_id: "gen",
  } as revisions.PromptRevision;
  const stageModule: SynapseModule<{ gap_ids: string[] }, unknown> = {
    manifest: {
      id: "fiction-stage",
      version: "1",
      stage: "S8",
      contract: 1,
      title: "fiction",
      summary: "synthetic",
      agentic: true,
      capabilities: [],
    },
    inputSchema: z.object({ gap_ids: z.array(z.string()) }),
    outputSchema: z.unknown(),
    freeze: async () => {
      throw new Error("live state read");
    },
    async run(input, ctx) {
      expect(inEvaluationIsolation()).toBe(true);
      expect(ctx.replay?.examples).toEqual([]);
      ctx.replay!.examples = [{ id: "injected", scope: "other_plans", kind: "s8_band", lesson: "Injected at execution" }];
      const result = await runAgenticCycle(
        ctx,
        "S8",
        {
          subjectOf: (band: string) => band,
          proposer: {
            local: () => {
              throw new Error("unexpected local proposer");
            },
            llm: async ({ hints }) => {
              expect(hints).toBe("");
              const output = await ctx.complete({ purpose: "band", system: "Assign a band", user: input.gap_ids[0] });
              return [(output as { band: string }).band];
            },
          },
          critic: () => [],
          judge: ({ candidates }) =>
            candidates.map((band) => ({ subject: band, candidate: band, score: 80, note: "fixture", verdict: "accept" })),
        },
        { text: "withheld answer", kinds: ["s8_band"] },
      );
      return {
        output: {
          mode: result.mode,
          placements: [{ gap_id: input.gap_ids[0], suggested_band: result.accepted[0], support_status: "supported" }],
        },
        summary: "fiction",
      };
    },
  };
  vi.spyOn(ai, "assertAiEnabled").mockResolvedValue();
  vi.spyOn(llm, "isTestStub").mockReturnValue(false);
  vi.spyOn(workspaces, "getWorkspace").mockResolvedValue({ id: "fiction", schema_name: "public" } as Awaited<
    ReturnType<typeof workspaces.getWorkspace>
  >);
  vi.spyOn(attempts, "claimRevisionBatch").mockResolvedValue({
    attempt: { revision: "candidate", workspace: "fiction", token: "test" },
  });
  vi.spyOn(attempts, "refreshRevisionBatch").mockResolvedValue();
  vi.spyOn(attempts, "sealRevisionBatch").mockResolvedValue();
  vi.spyOn(attempts, "releaseSealedBatch").mockResolvedValue();
  vi.spyOn(db, "ensurePlatformSchema").mockResolvedValue();
  vi.spyOn(db, "sharedDb").mockReturnValue({
    transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: vi.fn().mockResolvedValue([{}]) }),
  } as unknown as ReturnType<typeof db.sharedDb>);
  vi.spyOn(revisions, "getPromptRevision").mockResolvedValue(revision);
  vi.spyOn(revisions, "getRevisionCohort").mockResolvedValue(cohort);
  vi.spyOn(revisions, "activeRevisionPointer").mockResolvedValue({ generation: 0, revision_id: null });
  vi.spyOn(observability, "getRun").mockResolvedValue({
    workspace_id: "fiction",
    stage: "S8",
    status: "ok",
    module_id: "learning.prompt-revision",
    input: { cohort_id: cohort.id, reservation_hash: evidenceHash(cohort.gold_reservation) },
  } as observability.RunRecord);
  vi.spyOn(registry, "activeModule").mockResolvedValue(stageModule as Awaited<ReturnType<typeof registry.activeModule>>);
  vi.spyOn(approvedRoutes, "approvedEvaluationRoute").mockResolvedValue(route);
  const read = vi.spyOn(learning, "similarExamples").mockRejectedValue(new Error("unexpected runtime retrieval"));
  const completion = vi.fn(async ({ system }: { system: string }) => ({
    band: system.includes(revision.instruction_text) ? "low" : "high",
  }));
  vi.spyOn(routing, "completionFor").mockReturnValue(completion);
  return {
    read,
    completion,
    cohort,
    revision,
    evaluate: () => evaluatePromptRevision({ workspace_id: "fiction", actor, revision_id: revision.id }),
  };
}
afterEach(() => vi.restoreAllMocks());
describe("KAN-265 paired human-target replay", () => {
  it("runs repeated isolated arms with the same frozen inputs and recomputes eligibility from observations", async () => {
    const f = fixture();
    const evidence = await f.evaluate();
    expect(evidence.eligible, evidence.reasons.join(", ")).toBe(true);
    expect(f.read).not.toHaveBeenCalled();
    expect(evidence.observations).toHaveLength(18);
    expect(evidence.candidate.gold[0]).toMatchObject({ numerator: 9, denominator: 9, value: 1 });
    for (const change of [
      (e: typeof evidence) => { Object.assign(e.protocol!, { version: 3 }); },
      (e: typeof evidence) => {
        e.observations!.pop();
      },
      (e: typeof evidence) => {
        e.observations![0].snapshot_hash = "different";
      },
      (e: typeof evidence) => {
        e.observations![0].revision_id = "other";
      },
      (e: typeof evidence) => {
        e.observations![0].metrics = { format: 1 };
      },
      (e: typeof evidence) => {
        e.observations![0].metrics.band_agreement = 1;
        e.observations![1].metrics.band_agreement = 0;
      },
      (e: typeof evidence) => {
        e.targets![1].fingerprint = e.targets![0].fingerprint;
      },
      (e: typeof evidence) => {
        e.calls[0].user_hash = "injected";
      },
      (e: typeof evidence) => {
        e.baseline.combined = Infinity;
      },
      (e: typeof evidence) => {
        for (const t of e.targets!) t.metrics = ["format"];
      },
      (e: typeof evidence) => {
        e.candidate.gold[0].denominator = 0;
      },
    ]) {
      const tampered = structuredClone(evidence);
      change(tampered);
      expect(promotionEligibility(tampered).eligible).toBe(false);
    }
  });
  it("returns the binding completed result without buying another batch", async () => {
    const f = fixture();
    f.completion.mockResolvedValue({ band: "high" });
    const failed = await f.evaluate();
    expect(failed.eligible).toBe(false);
    vi.mocked(attempts.claimRevisionBatch).mockResolvedValue({ bound: failed });
    f.completion.mockClear();
    expect(await f.evaluate()).toEqual(failed);
    expect(f.completion).not.toHaveBeenCalled();
  });
  it("checkpoints a previously scored regression even when a later case fails", async () => {
    const f = fixture();
    let count = 0;
    f.completion.mockImplementation(async ({ system }) => {
      if (++count > 8) throw new Error("synthetic provider interrupted");
      return { band: system.includes("corrected") ? "high" : "low" };
    });
    const evidence = await f.evaluate();
    expect(evidence.eligible).toBe(false);
    expect(evidence.failures).toHaveLength(1);
    expect(attempts.refreshRevisionBatch).toHaveBeenCalledWith(expect.anything(), {
      case_id: evidence.targets![0].id,
      repeat: 0,
    });
  });
  it("permits a genuinely interrupted first batch to retry, while unscored model answers are binding", async () => {
    const f = fixture();
    const failure = new Error("synthetic timeout");
    failure.name = "TimeoutError";
    f.completion.mockRejectedValueOnce(failure);
    expect((await f.evaluate()).retryable).toBe(true);
    f.completion.mockRejectedValueOnce(new Error("invalid generated answer"));
    expect((await f.evaluate()).retryable).toBe(false);
  });
  it.each(["route", "fallback", "recording", "revision", "legacy", "unchanged", "stub"])(
    "refuses %s before a model call",
    async (kind) => {
      const f = fixture();
      if (kind === "route")
        vi.mocked(approvedRoutes.approvedEvaluationRoute).mockResolvedValue({
          ...route,
          params: { ...route.params, temperature: 1 },
        });
      if (kind === "fallback")
        vi.mocked(approvedRoutes.approvedEvaluationRoute).mockResolvedValue({ ...route, degraded: true });
      if (kind === "recording")
        vi.mocked(approvedRoutes.approvedEvaluationRoute).mockResolvedValue({ ...route, provider_id: "demo-replay" });
      if (kind === "revision")
        vi.mocked(revisions.activeRevisionPointer).mockResolvedValue({ generation: 2, revision_id: null });
      if (kind === "legacy") f.cohort.gold_reservation = null;
      if (kind === "unchanged") f.revision.instruction_text = "";
      if (kind === "stub") vi.mocked(llm.isTestStub).mockReturnValue(true);
      await expect(f.evaluate()).rejects.toThrow();
      expect(f.completion).not.toHaveBeenCalled();
    },
  );
  it("reserves fresh cases and withholds earlier holdouts from training, including restaged copies", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(row);
    const old = { heldout: executionLineage(rows[0])!, training: executionLineage(rows[7])! };
    const next = revisions.selectRevisionCohort(args, rows, approved, old);
    expect(next.excluded_ids).toContain(rows[0].id);
    expect(next.training_ids).not.toContain(rows[0].id);
    expect(next.heldout_ids).not.toContain(rows[7].id);
    expect(next.heldout_ids).toEqual([rows[6].id, rows[5].id, rows[4].id]);
  });
  it("connects a chain whose only shared input was a historical worked example", () => {
    const [a, b, c] = [1, 2, 3].map(row);
    Object.assign(b.replay_input!, { examples: [{ id: a.id, scope: "this_plan", kind: "s8_band" }] });
    Object.assign(c.replay_input!, { examples: [{ id: b.id, scope: "this_plan", kind: "s8_band" }] });
    expect(lineageGroups([c, b, a])).toHaveLength(1);
    expect(() => revisions.selectRevisionCohort(args, [c, b, a], approved)).toThrow("three independent");
    for (const example of [
      { id: "unknown", scope: "this_plan", kind: "s8_band" },
      { id: a.id, scope: "other_plans" },
    ]) {
      Object.assign(c.replay_input!, { examples: [example] });
      expect(() => revisions.selectRevisionCohort(args, [row(1), row(2), c], approved)).toThrow("three independent");
    }
  });
  it("follows frozen gap edits, need runs and normalized full source, keeping administrative entries separate", () => {
    const [a, b] = [1, 2].map(row);
    const state = (x: learning.DecisionExample) => (x.replay_input!.facts as { state: Record<string, unknown> }).state;
    expect(lineageGroups([a, b])).toHaveLength(2);
    const need = (x: learning.DecisionExample) => (state(x).needs as Record<string, unknown>[])[0];
    for (const x of [a, b]) need(x).run_id = "same-run";
    expect(lineageGroups([a, b])).toHaveLength(1);
    for (const x of [a, b]) {
      need(x).run_id = null;
      need(x).source_id = x.id;
      state(x).sources = [
        { id: x.id, full_text: x === a ? "Complete synthetic document." : " COMPLETE  synthetic document! " },
      ];
    }
    expect(lineageGroups([a, b])).toHaveLength(1);
    for (const x of [a, b]) {
      need(x).source_id = "SRC-PLAN-ENTRY";
      state(x).sources = [{ id: "SRC-PLAN-ENTRY", full_text: "Manual plan entry" }];
    }
    state(b).gap_versions = [
      {
        id: "version-1",
        live_gap_id: b.subject_id,
        retired_gap_id: "retired",
        statement: (a.ai_input.gap as { statement: string }).statement,
      },
    ];
    expect(lineageGroups([a, b])).toHaveLength(1);
    state(b).gap_versions = [];
    (state(b).gaps as Record<string, unknown>[])[0].related_gap_ids = [a.subject_id];
    expect(lineageGroups([a, b])).toHaveLength(1);
  });
  it("refuses missing, malformed and disconnected frozen S8 lineage", () => {
    for (const patch of [
      { asset: undefined },
      { objectives: undefined },
      { needs: undefined },
      { needs: [{}] },
      { need_gap_links: [] },
      { need_gap_links: [{ gap_id: "gap-3", need_id: "missing", role: "primary" }] },
      { sources: [] },
      { sources: {} },
      { gap_versions: [{ live_gap_id: 42 }] },
      { gaps: [{ id: "gap-3", statement: "Independent panel question 3", related_gap_ids: "lost" }] },
    ]) {
      const data = row(3);
      Object.assign((data.replay_input!.facts as { state: Record<string, unknown> }).state, patch);
      expect(executionLineage(data)).toBeNull();
      expect(() => revisions.selectRevisionCohort(args, [row(1), row(2), data], approved)).toThrow("three independent");
    }
  });
  it("seals a one-case gain before a postflight pointer read fails, then resumes without resampling", async () => {
    const f = fixture();
    f.completion.mockImplementation(async (args) => ({
      band: args.system.includes("corrected") && (args as { user?: string }).user === "gap-5" ? "low" : "high",
    }));
    vi.mocked(revisions.activeRevisionPointer)
      .mockResolvedValueOnce({ generation: 0, revision_id: null })
      .mockRejectedValueOnce(new Error("postflight DB unavailable"));
    await expect(f.evaluate()).rejects.toThrow("postflight DB unavailable");
    const final = vi.mocked(attempts.sealRevisionBatch).mock.calls.at(-1)!;
    expect(final[1].observations).toHaveLength(18);
    f.completion.mockClear();
    vi.mocked(attempts.claimRevisionBatch).mockResolvedValue({ attempt: final[0], sealed: final[1] });
    const result = await f.evaluate();
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toContain("two independent");
    expect(f.completion).not.toHaveBeenCalled();
  });
  it("seals an unscored model answer before a failing postflight module lookup", async () => {
    const f = fixture();
    f.completion.mockRejectedValueOnce(new Error("invalid generated answer"));
    const stage = await registry.activeModule("S8");
    vi.mocked(registry.activeModule)
      .mockResolvedValueOnce(stage)
      .mockRejectedValueOnce(new Error("postflight module unavailable"));
    await expect(f.evaluate()).rejects.toThrow("postflight module unavailable");
    expect(attempts.sealRevisionBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ failures: [expect.stringContaining("invalid generated answer")], interrupted: false }),
    );
    expect(attempts.releaseSealedBatch).toHaveBeenCalledTimes(1);
  });
  it("excludes foreign workspaces, unknown origin and same-content copies before reserving cases", () => {
    const one = row(1),
      duplicate = row(2);
    duplicate.ai_input = one.ai_input;
    Object.assign(duplicate.replay_input!, { execution: "test" });
    expect(() =>
      revisions.selectRevisionCohort(args, [one, duplicate, { ...row(3), workspace_id: "other" }, row(4)], approved),
    ).toThrow("three independent");
  });
});

describe("candidate training lessons", () => {
  const aliceFirst = { ...row(0), id: "alice-first", actor_principal: "alice", lesson: "Prioritize actionable evidence for imminent decisions." };
  const bobFirst = { ...aliceFirst, id: "bob-first", actor_principal: "bob", lesson: "Weigh the consequences of a delayed decision." };
  const aliceSecond = { ...row(1), id: "alice-second", actor_principal: "alice", lesson: "Check whether existing evidence addresses the question." };

  it("reassigns a lineage when only one of its reviewers can also cover a second lineage", () => {
    const examples = [aliceFirst, bobFirst, aliceSecond];
    const selected = revisions.selectTrainingLessons({ examples, training_ids: examples.map(example => example.id) }, []);
    expect(selected.map(lesson => lesson.id)).toEqual([bobFirst.id, aliceSecond.id]);
  });

  it("requires different scrubbed lesson text as well as different reviewers", () => {
    const examples = [aliceFirst, { ...bobFirst, lesson: aliceSecond.lesson }, aliceSecond];
    expect(() => revisions.selectTrainingLessons({ examples, training_ids: examples.map(example => example.id) }, []))
      .toThrow(/at least two identified reviewers/);
  });
});
