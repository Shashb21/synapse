import { describe, expect, it } from "vitest";
import { z } from "zod";
import "@/modules";
import {
  KERNEL_CONTRACT,
  STAGES,
  STAGE_IDS,
  type ModuleContext,
  type StageId,
  type SynapseModule,
} from "@/modules/kernel/contracts";
import { manifests, modulesForStage, registerModule } from "@/modules/kernel/registry";
import {
  PROPOSER_CRITIC_EXCHANGES,
  hasIssue,
  runAgenticCycle,
  thresholdJudge,
} from "@/modules/kernel/agentic";
import { RunRecorder } from "@/modules/kernel/observability";
import { canPrompt, DEFAULT_FALLBACKS, DEFAULT_PROVIDER_ID, resolveRoute } from "@/modules/kernel/routing";
import { digestAsPrompt } from "@/modules/kernel/hillclimb";
import { compositeScore } from "@/modules/kernel/baselines";
import { promptVersionsFor } from "@/modules/kernel/prompt-versions";
import { scoreMustMatch } from "@/modules/eval-gold/types";
import { scoresPassed } from "@/modules/kernel/evals";
import { requireRationale, RATIONALE_REQUIRED } from "@/modules/kernel/edit-records";
import {
  ALTERNATE_ROUTE_PROVIDER,
  DEFAULT_ROUTE_PROVIDER,
  PROVIDERS,
  findProvider,
  providerConfigured,
} from "@/modules/llm/provider";
import { can, capabilitiesOf, roleForFunction } from "@/modules/auth/roles";
import { DEFAULT_AXES, parseAxesConfig, validateAxes } from "@/modules/stages/s8-prioritization/axes";
import { addMonths, buildTimeline, monthsBetween, timelineCandidates } from "@/modules/stages/s10-timeline/build";
import { buildSeed } from "@/lib/iegp/seed";
import { displayedGapStatus } from "@/lib/iegp/engine";

describe("module contracts", () => {
  it("registers exactly one implementation per stage, all on the kernel contract", () => {
    for (const stage of STAGE_IDS) {
      const modules = modulesForStage(stage);
      expect(modules.length, `stage ${stage} has no module`).toBeGreaterThan(0);
      for (const candidate of modules) {
        expect(candidate.manifest.contract).toBe(KERNEL_CONTRACT);
        expect(candidate.manifest.stage).toBe(stage);
        expect(candidate.manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
    expect(manifests().length).toBeGreaterThanOrEqual(STAGE_IDS.length);
  });

  it("marks every agentic stage's module as agentic", () => {
    for (const stage of STAGE_IDS) {
      if (STAGES[stage].kind !== "agentic") continue;
      expect(modulesForStage(stage).some((candidate) => candidate.manifest.agentic)).toBe(true);
    }
  });

  it("refuses a module that speaks another contract version", () => {
    const stray = {
      manifest: {
        id: "s0-upload.from-the-future",
        stage: "S0",
        version: "9.0.0",
        title: "Future upload",
        summary: "Speaks a contract the kernel does not know.",
        contract: 2,
        agentic: false,
      },
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      async run() {
        return { output: {}, summary: "never runs" };
      },
    } as unknown as SynapseModule<unknown, unknown>;
    expect(() => registerModule(stray)).toThrow(/contract/i);
  });
});

describe("the locked agentic loop", () => {
  type Candidate = { id: string; text: string };

  function fakeContext(run: RunRecorder, stage: StageId = "S2"): ModuleContext {
    return {
      workspace_id: "test",
      actor: { name: "Loop Test", function: "medical_affairs" as const },
      role: "medical_affairs",
      run,
      route: {
        stage,
        provider_id: "xai-grok",
        provider_label: "xAI · Grok",
        model: "grok-4",
        auth: "oauth",
        connected: false,
        params: { temperature: 0, max_tokens: 8192 },
        fallbacks: DEFAULT_FALLBACKS,
        degraded: true,
        reason: "test fixture",
      },
      complete: async () => {
        throw new Error("test fixture does not prompt");
      },
    };
  }

  it("runs three proposer↔critic exchanges before the judge, and traces every round", async () => {
    const recorder = new RunRecorder({
      workspace_id: "test",
      stage: "S2",
      module_id: "loop.test",
      module_version: "1.0.0",
      actor: { name: "Loop Test", function: "medical_affairs" },
      input: {},
    });
    const proposerCalls: number[] = [];
    const criticRounds: number[] = [];

    const outcome = await runAgenticCycle<Candidate>(fakeContext(recorder), "S2", {
      subjectOf: (candidate) => candidate.id,
      proposer: {
        local: ({ round, previous, critiques }) => {
          proposerCalls.push(round);
          if (round === 1) {
            return [
              { id: "a", text: "keep me" },
              { id: "b", text: "drop me" },
              { id: "c", text: "fix me" },
            ];
          }
          // Concede the drops, repair what the critic asked for.
          return previous
            .filter(
              (candidate) =>
                critiques.find((critique) => critique.subject === candidate.id)?.verdict !== "drop",
            )
            .map((candidate) =>
              hasIssue(
                critiques.find((critique) => critique.subject === candidate.id),
                "needs_fix",
              )
                ? { ...candidate, text: "fixed" }
                : candidate,
            );
        },
      },
      critic: (candidates, round) => {
        criticRounds.push(round);
        return candidates.map((candidate) => {
          if (candidate.id === "b") {
            return { subject: candidate.id, verdict: "drop" as const, note: "not a gap", score: 10 };
          }
          if (candidate.text === "fix me") {
            return {
              subject: candidate.id,
              verdict: "revise" as const,
              note: "needs a fix",
              score: 45,
              issues: ["needs_fix"],
            };
          }
          return { subject: candidate.id, verdict: "keep" as const, note: "fine", score: 80 };
        });
      },
      judge: thresholdJudge<Candidate>((candidate) => candidate.id, 50),
    });

    expect(criticRounds).toEqual([1, 2, 3]);
    // One initial proposal plus one revision per exchange.
    expect(proposerCalls).toEqual([1, 2, 3, 4]);
    expect(outcome.rounds).toHaveLength(PROPOSER_CRITIC_EXCHANGES);
    expect(outcome.rounds[0]!.in).toBe(3);
    expect(outcome.rounds[0]!.dropped).toBe(1);
    expect(outcome.rounds[0]!.out).toBe(2);
    expect(outcome.rounds[2]!.in).toBe(2);

    // The dialogue repaired "fix me" and withdrew "drop me" before the judge saw anything.
    expect(outcome.judged.map((item) => item.subject).sort()).toEqual(["a", "c"]);
    expect(outcome.accepted.find((candidate) => candidate.id === "c")?.text).toBe("fixed");
    expect(outcome.rounds[2]!.avg_score).toBeGreaterThan(outcome.rounds[0]!.avg_score);

    const stepNames = recorder.steps().map((step) => step.name);
    expect(stepNames).toEqual([
      "hillclimb:hints",
      "round1:proposer",
      "round1:critic",
      "round1:proposer-revise",
      "round2:critic",
      "round2:proposer-revise",
      "round3:critic",
      "round3:proposer-revise",
      "withdrawn-in-dialogue",
      "judge",
      "exchanges",
    ]);
    // A candidate conceded mid-dialogue is still in the record, with the last word against it.
    expect(outcome.withdrawn.map((item) => item.subject)).toEqual(["b"]);
    expect(outcome.withdrawn[0]!.note).toBe("not a gap");
    expect(outcome.metrics.find((metric) => metric.name === "withdrawn_in_dialogue")!.value).toBe(1);

    const metricNames = outcome.metrics.map((metric) => metric.name);
    expect(metricNames).toContain("exchanges");
    expect(metricNames).toContain("dialogue_retention");
    expect(metricNames).toContain("critic_score_gain");
    expect(outcome.metrics.find((metric) => metric.name === "exchanges")!.value).toBe(
      PROPOSER_CRITIC_EXCHANGES,
    );
    expect(outcome.metrics.find((metric) => metric.name === "critic_score_gain")!.value).toBeGreaterThan(0);
  });

  it("keeps running the exchanges when the proposer has nothing left to concede", async () => {
    const recorder = new RunRecorder({
      workspace_id: "test",
      stage: "S4",
      module_id: "loop.test",
      module_version: "1.0.0",
      actor: { name: "Loop Test", function: "medical_affairs" },
      input: {},
    });
    const outcome = await runAgenticCycle<Candidate>(fakeContext(recorder, "S4"), "S4", {
      subjectOf: (candidate) => candidate.id,
      proposer: { local: ({ round }) => (round === 1 ? [{ id: "only", text: "one" }] : []) },
      critic: (candidates) =>
        candidates.map((candidate) => ({
          subject: candidate.id,
          verdict: "drop" as const,
          note: "no",
          score: 5,
        })),
      judge: thresholdJudge<Candidate>((candidate) => candidate.id),
    });
    expect(outcome.rounds).toHaveLength(PROPOSER_CRITIC_EXCHANGES);
    expect(outcome.judged).toHaveLength(0);
    expect(outcome.metrics.find((metric) => metric.name === "dialogue_retention")!.value).toBe(0);
  });
});

describe("routing defaults", () => {
  it("defaults to Grok with Claude as the standing alternate", () => {
    expect(DEFAULT_PROVIDER_ID).toBe("xai-grok");
    expect(DEFAULT_ROUTE_PROVIDER).toBe("xai-grok");
    expect(ALTERNATE_ROUTE_PROVIDER).toBe("anthropic-claude");
    expect(DEFAULT_FALLBACKS[0]).toBe("anthropic-claude");
    expect(DEFAULT_FALLBACKS).toEqual(["anthropic-claude", "openai"]);
  });

  it("ships the five locked OAuth providers", () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(ids).toEqual([
      "xai-grok",
      "anthropic-claude",
      "openai",
      "google-gemini",
      "openrouter",
    ]);
    for (const provider of PROVIDERS) {
      expect(provider.auth).toBe("oauth");
      expect(provider.oauth?.authorize_url).toMatch(/^https:\/\//);
      expect(provider.oauth?.token_url).toMatch(/^https:\/\//);
    }
  });

  it("treats every MVP provider as OAuth-ready without operator client env vars", () => {
    for (const provider of PROVIDERS) {
      expect(providerConfigured(provider)).toBe(true);
    }
  });

  it("blocks agentic routing when no provider is connected", async () => {
    const keyEnvs = ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const name of keyEnvs) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    try {
      await expect(resolveRoute("S2")).rejects.toThrow(/control panel/i);
    } finally {
      for (const name of keyEnvs) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
    expect(
      canPrompt({
        stage: "S2",
        provider_id: "xai-grok",
        provider_label: "xAI · Grok",
        model: "grok-4",
        auth: "oauth",
        connected: false,
        params: { temperature: 0, max_tokens: 8192 },
        fallbacks: DEFAULT_FALLBACKS,
        degraded: true,
        reason: "disconnected",
      }),
    ).toBe(false);
    expect(
      canPrompt({
        stage: "S2",
        provider_id: "xai-grok",
        provider_label: "xAI · Grok",
        model: "grok-4",
        auth: "oauth",
        connected: true,
        params: { temperature: 0, max_tokens: 8192 },
        fallbacks: DEFAULT_FALLBACKS,
        degraded: false,
        reason: null,
      }),
    ).toBe(true);
  });
});

describe("curated eval gold", () => {
  it("scores must-match needles against accepted statements", () => {
    const hit = scoreMustMatch(["intracranial outcomes in brain metastases"], ["intracranial", "sequencing"]);
    expect(hit.value).toBeGreaterThan(0);
    expect(hit.detail).toContain("1/2");
  });
});

describe("hillclimb prompt variants", () => {
  it("registers multiple versions for agentic stages", () => {
    expect(promptVersionsFor("S2").length).toBeGreaterThan(1);
    expect(promptVersionsFor("S0")).toEqual(["v1.0-baseline"]);
  });

  it("composites targeted metrics for baseline comparison", () => {
    const high = compositeScore([{ name: "a", value: 0.9, target: 0.8 }]);
    const low = compositeScore([{ name: "a", value: 0.4, target: 0.8 }]);
    expect(high).toBeGreaterThan(low);
  });
});

describe("rationale, evals and hillclimb plumbing", () => {
  it("requires a rationale on every edit", () => {
    expect(() => requireRationale("")).toThrow(RATIONALE_REQUIRED);
    expect(() => requireRationale("no")).toThrow(RATIONALE_REQUIRED);
    expect(requireRationale("  HTA asked for it  ")).toBe("HTA asked for it");
  });

  it("renders reviewer corrections as prompt text, and nothing when there are none", () => {
    expect(digestAsPrompt({ stage: "S2", open: 0, corrections: [], by_kind: {} })).toBe("");
    const prompt = digestAsPrompt({
      stage: "S2",
      open: 1,
      corrections: ["Do not treat a publication plan line as a gap"],
      by_kind: { user_edit: 1 },
    });
    expect(prompt).toContain("Reviewer corrections");
    expect(prompt).toContain("- Do not treat a publication plan line as a gap");
  });

  it("passes an eval run only when every targeted score clears its target", () => {
    expect(scoresPassed([{ name: "a", value: 0.9, target: 0.8 }])).toBe(true);
    expect(scoresPassed([{ name: "a", value: 0.7, target: 0.8 }])).toBe(false);
    expect(scoresPassed([{ name: "a", value: 0 }])).toBe(true);
  });
});

describe("roles", () => {
  it("keeps control-panel routing open to every role and save-final off viewers", () => {
    for (const role of ["medical_affairs", "contributor", "operator", "viewer"] as const) {
      expect(can(role, "configure_routing")).toBe(true);
    }
    expect(can("medical_affairs", "save_final")).toBe(true);
    expect(can("contributor", "save_final")).toBe(false);
    expect(can("viewer", "validate")).toBe(false);
    expect(capabilitiesOf("operator")).toContain("activate_module");
    expect(can("medical_affairs", "activate_module")).toBe(false);
  });

  it("maps Medical Affairs and evidence leads to the primary role", () => {
    expect(roleForFunction("medical_affairs")).toBe("medical_affairs");
    expect(roleForFunction("evidence_lead")).toBe("medical_affairs");
    expect(roleForFunction("heor")).toBe("contributor");
  });
});

describe("prioritization axes", () => {
  it("rejects a malformed axis configuration before it is stored", () => {
    expect(() => parseAxesConfig({ axes: [], x_axis: "a", y_axis: "b", bands: { high: 60, medium: 40 } })).toThrow(
      /malformed/i,
    );
    expect(() =>
      parseAxesConfig({
        ...DEFAULT_AXES,
        axes: [{ ...DEFAULT_AXES.axes[0]!, weight: 99 }, DEFAULT_AXES.axes[1]!],
      }),
    ).toThrow(/weight/i);
    expect(() =>
      parseAxesConfig({
        ...DEFAULT_AXES,
        axes: [{ ...DEFAULT_AXES.axes[0]!, id: "Decision Impact" }, DEFAULT_AXES.axes[1]!],
      }),
    ).toThrow(/lowercase/i);
    expect(parseAxesConfig(DEFAULT_AXES).axes.length).toBe(DEFAULT_AXES.axes.length);
  });

  it("rejects configurations the matrix cannot draw", () => {
    expect(() => validateAxes({ ...DEFAULT_AXES, axes: [DEFAULT_AXES.axes[0]!] })).toThrow(/two axes/i);
    expect(() => validateAxes({ ...DEFAULT_AXES, y_axis: DEFAULT_AXES.x_axis })).toThrow(/different axes/i);
    expect(() => validateAxes({ ...DEFAULT_AXES, x_axis: "nope" })).toThrow(/configured axes/i);
    expect(() => validateAxes({ ...DEFAULT_AXES, bands: { high: 30, medium: 40 } })).toThrow(/threshold/i);
    expect(validateAxes(DEFAULT_AXES)).toBe(DEFAULT_AXES);
  });
});

describe("timeline build", () => {
  it("walks months without drifting off the end of a month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-15", 9)).toBe("2026-12-15");
    expect(monthsBetween("2026-01-10", "2026-03-10")).toBe(3);
  });

  const validated = (gapId: string, band: "high" | "medium" | "low", isValidated = true) => ({
    gap_id: gapId,
    axis_scores: { decision_impact: 80 },
    suggested_band: band,
    suggested_rationale: "seeded",
    band,
    validated: isValidated,
    rationale: isValidated ? "seeded" : null,
    actor_name: "Test",
    at: "2026-01-01T00:00:00.000Z",
  });

  /** Every candidate estimated in full, so the layout is exercised on supplied values only. */
  const estimateAll = (state: ReturnType<typeof buildSeed>, placements: ReturnType<typeof validated>[]) =>
    new Map(
      timelineCandidates({ state, placements }).map((candidate) => [
        candidate.id,
        { start_offset_months: 2, duration_months: 6, readout_lag_months: 1, rationale: "estimated" },
      ]),
    );

  it("lays out only the values it is given and never dates a tactic on its own", () => {
    const state = buildSeed();
    const bare = buildTimeline({ state, placements: [], anchor: "2026-01-01" });
    // Seed tactics carry a start date but no designed duration: nothing is invented.
    expect(bare.activities).toHaveLength(0);
    expect(bare.pending.length).toBeGreaterThan(0);
    for (const row of bare.pending) expect(row.missing).toContain("duration");

    const model = buildTimeline({
      state,
      placements: [],
      estimates: estimateAll(state, []),
      anchor: "2026-01-01",
    });
    expect(model.pending).toHaveLength(0);
    expect(model.activities.length).toBe(bare.pending.length);
    for (const activity of model.activities) {
      const tactic = state.tactics.find((row) => row.id === activity.tactic_id)!;
      expect(activity.start_date).toBe(tactic.start_date ?? "2026-03-01");
      expect(activity.end_date).toBe(addMonths(activity.start_date, 6));
      expect(activity.readout_date).toBe(tactic.evidence_available ?? addMonths(activity.end_date, 1));
      expect(activity.meta.schedule_basis.end).toBe("model");
      expect(activity.depends_on).toEqual([]);
    }
    expect(model.lanes.map((lane) => lane.id)).toEqual(["high", "medium", "low", "unprioritized", "addressed"]);
    expect(model.window.months).toBeGreaterThan(0);
  });

  it("lanes an activity only by a validated band", () => {
    const state = buildSeed();
    const probe = timelineCandidates({ state, placements: [] }).find((candidate) => candidate.band !== "addressed")!;
    const gapId = probe.gap_ids.find((id) => {
      const gap = state.gaps.find((row) => row.id === id);
      return gap && displayedGapStatus(gap) !== "validated_addressed";
    })!;
    const others = probe.gap_ids.filter((id) => id !== gapId);
    const suggestedOnly = [validated(gapId, "high", false), ...others.map((id) => validated(id, "high", false))];
    const unvalidated = timelineCandidates({ state, placements: suggestedOnly }).find((row) => row.id === probe.id)!;
    expect(unvalidated.band).toBe("unprioritized");

    const placed = [validated(gapId, "medium"), ...others.map((id) => validated(id, "low", false))];
    const model = buildTimeline({ state, placements: placed, estimates: estimateAll(state, placed), anchor: "2026-01-01" });
    const activity = model.activities.find((row) => row.id === probe.id)!;
    expect(activity.band).toBe("medium");
    expect(activity.lane).toBe("medium");
  });

  it("gates a model-dated start on the readouts the model said it depends on", () => {
    const state = buildSeed();
    const [upstream, downstream] = timelineCandidates({ state, placements: [] });
    // The downstream tactic has no start of its own, so its start is the model's to set.
    const tactic = state.tactics.find((row) => row.id === downstream!.tactic.id)!;
    tactic.start_date = null;
    tactic.evidence_available = null;
    const model = buildTimeline({
      state,
      placements: [],
      estimates: estimateAll(state, []),
      dependencies: new Map([
        [downstream!.id, { upstream: [{ id: upstream!.id, reason: "reports its results" }] }],
      ]),
      anchor: "2020-01-01",
    });
    const before = model.activities.find((row) => row.id === upstream!.id)!;
    const after = model.activities.find((row) => row.id === downstream!.id)!;
    expect(after.depends_on).toEqual([upstream!.id]);
    expect(after.start_date).toBe(before.readout_date);
    expect(after.end_date).toBe(addMonths(after.start_date, 6));
    expect(after.meta.dependency_note).toMatch(/reports its results/);
  });

  it("keeps a user's saved dates when it rebuilds", () => {
    const state = buildSeed();
    const first = buildTimeline({ state, placements: [], estimates: estimateAll(state, []), anchor: "2026-01-01" });
    const target = first.activities[0]!;
    const second = buildTimeline({
      state,
      placements: [],
      anchor: "2026-01-01",
      overrides: [
        {
          id: target.id,
          start_date: "2027-05-01",
          end_date: "2027-11-01",
          readout_date: "2027-12-01",
          lane: target.lane,
          depends_on: [],
        },
      ],
    });
    const moved = second.activities.find((activity) => activity.id === target.id)!;
    expect(moved.start_date).toBe("2027-05-01");
    expect(moved.end_date).toBe("2027-11-01");
    expect(moved.readout_date).toBe("2027-12-01");
    expect(moved.meta.schedule_basis.start).toBe("saved");
  });
});
