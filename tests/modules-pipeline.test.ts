import { beforeAll, describe, expect, it } from "vitest";
import "@/modules";
import { runStage } from "@/modules/kernel/run";
import { wipePlatform } from "@/modules/kernel/db";
import { getRun, listRuns } from "@/modules/kernel/observability";
import { listEdits } from "@/modules/kernel/edit-records";
import { hillclimbDigest, listSignals } from "@/modules/kernel/hillclimb";
import { listEvalRuns } from "@/modules/kernel/evals";
import { routeConfig, resolveRoute, setDefaultProvider, setRouteConfig } from "@/modules/kernel/routing";
import { activateModule, stageWiring } from "@/modules/kernel/registry";
import { displayedGapStatus, isLiveGap } from "@/lib/iegp/engine";
import { loadState, resetSeed } from "@/lib/iegp/store";
import { listSourceFiles } from "@/modules/stages/s0-upload/module";
import { listParsedDocuments } from "@/modules/stages/s1-parse/module";
import { listGapCandidates } from "@/modules/stages/s2-gap-extract/module";
import { listMappingCandidates } from "@/modules/stages/s4-kg-mapping/module";
import { listPlacements, validatePlacement } from "@/modules/stages/s8-prioritization/module";
import { decideIdeationProposal, listIdeationProposals } from "@/modules/stages/s9-ideation/module";
import { latestPlan, savePlan, timelineModel, updateTimelineActivity } from "@/modules/stages/s10-timeline/module";
import type { ConsolidationOutput } from "@/modules/stages/s7-consolidation/module";
import type { GapExtractOutput } from "@/modules/stages/s2-gap-extract/module";
import type { MappingOutput } from "@/modules/stages/s4-kg-mapping/module";
import type { ParseOutput } from "@/modules/stages/s1-parse/module";
import type { PrioritizationOutput } from "@/modules/stages/s8-prioritization/module";
import type { TacticExtractOutput } from "@/modules/stages/s3-tactic-extract/module";
import type { TimelineOutput } from "@/modules/stages/s10-timeline/module";
import type { UploadOutput } from "@/modules/stages/s0-upload/module";

const ACTOR = { name: "Contract Test", function: "medical_affairs" as const };
const LEAD = { actor: ACTOR, role: "medical_affairs" as const };

async function run<O>(stage: Parameters<typeof runStage>[0]["stage"], input: unknown) {
  return runStage<O>({ stage, input, ...LEAD });
}

describe("modular pipeline, S0 to S10", () => {
  beforeAll(async () => {
    await resetSeed();
    await wipePlatform([
      "source_files",
      "parsed_documents",
      "gap_candidates",
      "tactic_candidates",
      "mapping_candidates",
    ]);
  }, 60_000);

  it("uploads files without parsing them, and rejects a duplicate", async () => {
    const first = await run<UploadOutput>("S0", {
      demo_ids: ["heor-interview", "medical-kol"],
    });
    expect(first.output.files.length).toBe(2);
    expect(first.output.files[0]!.checksum).toMatch(/^[0-9a-f]{32}$/);
    const again = await run<UploadOutput>("S0", { demo_ids: ["heor-interview"] });
    expect(again.output.files).toHaveLength(0);
    expect(again.output.skipped[0]!.reason).toMatch(/identical/);

    const files = await listSourceFiles();
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.status === "uploaded")).toBe(true);
    const state = await loadState();
    expect(state.sources).toHaveLength(0);
  }, 60_000);

  it("parses each file into blocks with quality signals and a domain source", async () => {
    const result = await run<ParseOutput>("S1", {});
    expect(result.output.documents).toHaveLength(2);
    expect(result.output.failures).toHaveLength(0);
    for (const document of result.output.documents) {
      expect(document.blocks).toBeGreaterThan(0);
      expect(document.quality.characters).toBeGreaterThan(100);
    }
    const documents = await listParsedDocuments();
    expect(documents).toHaveLength(2);
    const state = await loadState();
    expect(state.sources).toHaveLength(2);
    expect(state.gaps).toHaveLength(0);
  }, 60_000);

  it("extracts gaps through proposer, critic and judge and commits only what it accepts", async () => {
    const result = await run<GapExtractOutput>("S2", {});
    expect(result.mode).toBe("deterministic");
    expect(result.output.proposed).toBeGreaterThan(0);
    expect(result.output.accepted.length).toBeGreaterThan(0);
    expect(result.output.committed_gap_ids.length).toBeGreaterThan(0);
    for (const candidate of result.output.accepted) {
      expect(candidate.source_quote.trim().length).toBeGreaterThan(0);
      expect(candidate.score).toBeGreaterThanOrEqual(45);
    }
    const candidates = await listGapCandidates();
    expect(candidates.length).toBe(result.output.accepted.length + result.output.rejected.length);

    const state = await loadState();
    const live = state.gaps.filter(isLiveGap);
    expect(live.length).toBe(result.output.committed_gap_ids.length);
    for (const gap of live) {
      expect(state.need_gap_links.some((link) => link.gap_id === gap.id)).toBe(true);
    }
  }, 120_000);

  it("extracts tactics into the library", async () => {
    const result = await run<TacticExtractOutput>("S3", {});
    expect(result.output.proposed).toBeGreaterThan(0);
    const state = await loadState();
    expect(state.tactics.length).toBe(result.output.committed_tactic_ids.length);
  }, 120_000);

  it("maps gaps to tactics via the mapping table and joins accepted rows", async () => {
    const result = await run<MappingOutput>("S4", {});
    expect(result.output.proposed).toBeGreaterThan(0);
    expect(result.output.rows.length).toBeGreaterThan(0);
    expect(result.output.committed.length).toBeGreaterThan(0);
    const candidates = await listMappingCandidates();
    expect(candidates.length).toBeGreaterThan(0);

    const state = await loadState();
    const joinedTactics = result.output.committed.flatMap((row) => row.tactic_ids);
    expect(joinedTactics.length).toBeGreaterThan(0);
    expect(state.coverages.length).toBeGreaterThanOrEqual(joinedTactics.length);
    expect(result.output.accepted.some((row) => row.rationale.length > 0)).toBe(true);
  }, 120_000);

  it("records a rationale and a hillclimb signal for every validation gate edit", async () => {
    const state = await loadState();
    const gap = state.gaps.filter(isLiveGap)[0]!;
    await expect(
      runStage({ stage: "S5", input: { action: "validate", gap_id: gap.id, rationale: "x" }, ...LEAD }),
    ).rejects.toThrow();

    await runStage({
      stage: "S5",
      input: {
        action: "edit_gap",
        gap_id: gap.id,
        name: gap.name,
        statement: `${gap.statement} Restated for the HTA submission.`,
        rationale: "Sharpened for the HTA submission question",
      },
      ...LEAD,
    });
    const edits = await listEdits({ stage: "S5" });
    expect(edits[0]!.rationale).toMatch(/HTA submission/);
    const signals = await listSignals({ stage: "S5" });
    expect(signals[0]!.subject).toBe(`gap:${gap.id}`);
    const digest = await hillclimbDigest("S5");
    expect(digest.corrections[0]).toMatch(/HTA submission/);
  }, 60_000);

  it("consolidates open and addressed lists and flags every unresolved partial", async () => {
    const result = await run<ConsolidationOutput>("S7", {});
    expect(result.output.open.length).toBeGreaterThan(0);
    expect(result.output.flags.some((flag) => flag.code === "not_validated")).toBe(true);
    // Partial cannot enter the validated set, so each one must carry its flag.
    for (const partial of result.output.unresolved_partials) {
      expect(
        result.output.flags.some(
          (flag) => flag.code === "partial_unresolved" && flag.gap_id === partial.gap_id,
        ),
      ).toBe(true);
    }
    expect(result.output.ready_for_prioritization).toBe(false);
    const state = await loadState();
    const partialIds = state.gaps
      .filter(isLiveGap)
      .filter((gap) => displayedGapStatus(gap) === "validated_partial")
      .map((gap) => gap.id)
      .sort();
    expect(result.output.unresolved_partials.map((row) => row.gap_id).sort()).toEqual(partialIds);
  }, 60_000);

  it("suggests priority bands on the configured axes and keeps a validated band on re-run", async () => {
    const suggested = await run<PrioritizationOutput>("S8", {});
    expect(suggested.output.placements.length).toBeGreaterThan(0);
    expect(suggested.output.axes.length).toBeGreaterThanOrEqual(2);

    const target = suggested.output.placements[0]!;
    await validatePlacement({
      gap_id: target.gap_id,
      band: "high",
      rationale: "Blocks the reimbursement submission",
      actor: ACTOR,
    });
    let placements = await listPlacements();
    const validated = placements.find((row) => row.gap_id === target.gap_id)!;
    expect(validated.validated).toBe(true);
    expect(validated.band).toBe("high");

    await run<PrioritizationOutput>("S8", {});
    placements = await listPlacements();
    const after = placements.find((row) => row.gap_id === target.gap_id)!;
    expect(after.validated).toBe(true);
    expect(after.band).toBe("high");
    // The suggestion the human judged survives a re-run, so the delta stays readable.
    expect(after.suggested_band).toBe(validated.suggested_band);
    expect(after.suggested_rationale).toBe(validated.suggested_rationale);

    const edits = await listEdits({ stage: "S8" });
    expect(edits[0]!.rationale).toMatch(/reimbursement/);
  }, 120_000);

  it("ideates tactics for the High gap and turns an accepted proposal into a mapped tactic", async () => {
    const result = await runStage({ stage: "S9", input: { per_gap: 2 }, ...LEAD });
    const output = result.output as { proposals: { id: string }[]; gaps_considered: number };
    expect(output.gaps_considered).toBeGreaterThan(0);
    expect(output.proposals.length).toBeGreaterThan(0);

    const proposals = await listIdeationProposals();
    const first = proposals[0]!;
    const before = (await loadState()).tactics.length;
    const decision = await decideIdeationProposal({
      id: first.id,
      decision: "accept",
      rationale: "Cheapest design that answers the comparator question",
      actor: ACTOR,
    });
    expect(decision.tactic_id).toBeTruthy();
    const state = await loadState();
    expect(state.tactics.length).toBe(before + 1);
    expect(
      state.coverages.some(
        (coverage) => coverage.tactic_id === decision.tactic_id && coverage.gap_id === first.gap_id,
      ),
    ).toBe(true);
    expect((await listEdits({ stage: "S9" }))[0]!.rationale).toMatch(/comparator/);
  }, 120_000);

  it("builds the Gantt timeline, keeps a moved activity and saves the plan as final", async () => {
    const built = await run<TimelineOutput>("S10", { persist: true, anchor: "2026-01-01" });
    expect(built.output.activities.length).toBeGreaterThan(0);
    expect(built.output.window.months).toBeGreaterThan(0);
    const highLane = built.output.lanes.find((lane) => lane.id === "high")!;
    expect(highLane.count).toBeGreaterThan(0);

    const activity = built.output.activities[0]!;
    await expect(
      updateTimelineActivity({
        id: activity.id,
        start_date: "2027-01-01",
        end_date: "2026-06-01",
        rationale: "invalid window",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/cannot end before/i);

    await updateTimelineActivity({
      id: activity.id,
      start_date: "2027-01-01",
      end_date: "2027-09-01",
      rationale: "Site contracts slip to Q1 2027",
      actor: ACTOR,
    });
    const rebuilt = await timelineModel("2026-01-01");
    const moved = rebuilt.activities.find((row) => row.id === activity.id)!;
    expect(moved.start_date).toBe("2027-01-01");

    const plan = await savePlan({ status: "final", note: "Signed off in the Q1 review", actor: ACTOR });
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("final");
    expect(plan.snapshot.activities.length).toBe(rebuilt.activities.length);
    const saved = await latestPlan();
    expect(saved?.status).toBe("final");
    expect((await listEdits({ stage: "S10" }))[0]!.rationale).toMatch(/Q1 review/);
  }, 180_000);

  it("traces every run with route, steps and eval scores", async () => {
    const runs = await listRuns({ limit: 100 });
    expect(runs.length).toBeGreaterThan(8);
    // The only failures so far are the contract violations this suite provoked.
    for (const record of runs.filter((candidate) => candidate.status === "error")) {
      expect(record.error ?? "").toMatch(/rejected its input/i);
    }
    for (const stage of ["S0", "S1", "S2", "S3", "S4", "S7", "S8", "S9", "S10"] as const) {
      expect(runs.some((record) => record.stage === stage && record.status === "ok")).toBe(true);
    }
    const extract = runs.find((record) => record.stage === "S2")!;
    const detail = await getRun(extract.id);
    expect(detail?.steps.some((step) => step.name === "round1:proposer")).toBe(true);
    expect(detail?.steps.some((step) => step.name === "round1:critic")).toBe(true);
    expect(detail?.steps.some((step) => step.name === "judge")).toBe(true);
    expect(detail?.route?.provider_id).toBe("xai-grok");
    expect(detail?.evals.some((score) => score.name === "accept_rate")).toBe(true);
    const evalRuns = await listEvalRuns({ stage: "S2" });
    expect(evalRuns.length).toBeGreaterThan(0);
  }, 60_000);

  it("gives every agentic stage three proposer↔critic exchanges before its judge", async () => {
    const runs = await listRuns({ limit: 200 });
    for (const stage of ["S2", "S3", "S4", "S8", "S9"] as const) {
      const record = runs.find((candidate) => candidate.stage === stage && candidate.status === "ok");
      expect(record, `no successful ${stage} run`).toBeTruthy();
      const detail = await getRun(record!.id);
      const names = detail!.steps.map((step) => step.name);
      for (const round of [1, 2, 3]) {
        expect(names, `${stage} round ${round} critic`).toContain(`round${round}:critic`);
        expect(names, `${stage} round ${round} revision`).toContain(`round${round}:proposer-revise`);
      }
      // The judge comes last, after the third exchange.
      expect(names.indexOf("judge")).toBeGreaterThan(names.indexOf("round3:critic"));
      const exchanges = detail!.steps.find((step) => step.name === "exchanges");
      expect((exchanges?.data as unknown[] | undefined)?.length).toBe(3);
      expect(detail!.evals.find((score) => score.name === "exchanges")?.value).toBe(3);
      expect(detail!.evals.some((score) => score.name === "dialogue_retention")).toBe(true);
      expect(detail!.evals.some((score) => score.name === "critic_score_gain")).toBe(true);
    }
  }, 60_000);

  it("runs the split proposal through the same three exchanges", async () => {
    const consolidated = await run<ConsolidationOutput>("S7", {});
    const partial = consolidated.output.unresolved_partials[0];
    if (!partial) return;
    const result = await runStage({ stage: "S6", input: { gap_id: partial.gap_id }, ...LEAD });
    const detail = await getRun(result.run_id);
    const names = detail!.steps.map((step) => step.name);
    expect(names).toContain("round3:critic");
    expect(names.indexOf("judge")).toBeGreaterThan(names.indexOf("round3:critic"));
    expect((result.output as { proposal: unknown }).proposal).toBeTruthy();
  }, 60_000);

  it("rejects input that breaks a module's contract and records the failed run", async () => {
    await expect(
      runStage({ stage: "S4", input: { max_per_gap: 99 }, ...LEAD }),
    ).rejects.toThrow(/rejected its input/i);
    const failed = (await listRuns({ stage: "S4", limit: 5 })).find((record) => record.status === "error");
    expect(failed?.error ?? "").toMatch(/rejected its input/i);
  }, 60_000);

  it("enforces role capabilities at the stage boundary", async () => {
    await expect(
      runStage({ stage: "S8", input: {}, actor: ACTOR, role: "viewer" }),
    ).rejects.toThrow(/may not prioritize/i);
    await expect(
      runStage({ stage: "S2", input: {}, actor: ACTOR, role: "viewer" }),
    ).rejects.toThrow(/may not run stage/i);
  }, 60_000);

  it("switches every stage to one provider in a single action and degrades when it is not connected", async () => {
    await setDefaultProvider({ provider_id: "anthropic-claude", actor_name: ACTOR.name });
    const claude = await routeConfig("S2");
    expect(claude.provider_id).toBe("anthropic-claude");
    expect(claude.fallbacks).toContain("xai-grok");

    await expect(resolveRoute("S2")).rejects.toThrow(/control panel/i);

    await setRouteConfig({
      stage: "S2",
      provider_id: "xai-grok",
      model: "grok-4",
      actor_name: ACTOR.name,
    });
    expect((await routeConfig("S2")).model).toBe("grok-4");
    await expect(
      setRouteConfig({ stage: "S2", provider_id: "xai-grok", model: "not-a-model", actor_name: ACTOR.name }),
    ).rejects.toThrow(/does not serve/i);
  }, 60_000);

  it("activates a named module per stage, which is how a stage is upgraded", async () => {
    await activateModule({ stage: "S1", module_id: "s1-parse.local", actor_name: ACTOR.name });
    const wiring = await stageWiring();
    const parse = wiring.find((row) => row.stage === "S1")!;
    expect(parse.active?.id).toBe("s1-parse.local");
    expect(parse.activated_by).toBe(ACTOR.name);
    await expect(
      activateModule({ stage: "S1", module_id: "s2-gap-extract.pcj", actor_name: ACTOR.name }),
    ).rejects.toThrow(/implements S2/i);
  }, 60_000);

  it("leaves no partially addressed gap unresolved in the final plan", async () => {
    const state = await loadState();
    const partials = state.gaps
      .filter(isLiveGap)
      .filter((gap) => displayedGapStatus(gap) === "validated_partial");
    const plan = await latestPlan();
    expect(plan).not.toBeNull();
    if (partials.length > 0) {
      const consolidated = await run<ConsolidationOutput>("S7", {});
      expect(consolidated.output.unresolved_partials.length).toBe(partials.length);
    }
  }, 60_000);
});
