import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Shared harness for the feature specs. Setup goes through the module API so each
 * feature can seed exactly the state it needs and fail on its own.
 */

export const ACTOR = { actor_name: "Feature E2E", actor_function: "medical_affairs" } as const;

/** Two demo sources are enough for every feature and keep the specs quick. */
export const DEMO_SOURCES = ["heor-interview", "medical-kol"];

export type EvalScore = { name: string; value: number; target?: number; detail?: string };

export type StageResult<O = unknown> = {
  run_id: string;
  stage: string;
  module_id: string;
  module_version: string;
  mode: "llm" | "deterministic";
  summary: string;
  output: O;
  evals: EvalScore[];
};

export type RunStep = { name: string; detail: string | null; data: unknown; duration_ms: number | null };

export type AgenticRoundRow = {
  round: number;
  proposer: "llm" | "local";
  in: number;
  critiqued: number;
  kept: number;
  to_revise: number;
  dropped: number;
  out: number;
  avg_score: number;
};

export type RunRecord = {
  id: string;
  stage: string;
  module_id: string;
  status: "running" | "ok" | "error";
  summary: string | null;
  error: string | null;
  steps: RunStep[];
  evals: EvalScore[];
  route: {
    provider_id: string;
    provider_label: string;
    model: string;
    auth: "oauth" | "none";
    connected: boolean;
    degraded: boolean;
    reason: string | null;
  } | null;
};

async function postJson(request: APIRequestContext, url: string, body: Record<string, unknown>) {
  const response = await request.post(url, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ ...ACTOR, ...body }),
  });
  const text = await response.text();
  if (!response.ok()) throw new Error(`${url} ${JSON.stringify(body)} → ${response.status()} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export async function resetWorkspace(request: APIRequestContext) {
  await postJson(request, "/api/iegp", { action: "reset" });
}

export async function runStage<O = unknown>(
  request: APIRequestContext,
  stage: string,
  input: Record<string, unknown> = {},
): Promise<StageResult<O>> {
  return (await postJson(request, "/api/modules", { stage, input })) as unknown as StageResult<O>;
}

/** Same call, but returns the error body instead of throwing. Used for guard tests. */
export async function runStageExpectingError(
  request: APIRequestContext,
  stage: string,
  input: Record<string, unknown> = {},
): Promise<{ status: number; error: string }> {
  const response = await request.post("/api/modules", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ ...ACTOR, stage, input }),
  });
  const body = (await response.json()) as { error?: string };
  return { status: response.status(), error: body.error ?? "" };
}

export async function planAction(request: APIRequestContext, body: Record<string, unknown>) {
  return postJson(request, "/api/plan", body);
}

export async function planActionExpectingError(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; error: string }> {
  const response = await request.post("/api/plan", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ ...ACTOR, ...body }),
  });
  const payload = (await response.json()) as { error?: string };
  return { status: response.status(), error: payload.error ?? "" };
}

export async function iegpAction(request: APIRequestContext, body: Record<string, unknown>) {
  return postJson(request, "/api/iegp", body);
}

export async function controlAction(request: APIRequestContext, body: Record<string, unknown>) {
  return postJson(request, "/api/control", body);
}

export async function controlActionExpectingError(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; error: string }> {
  const response = await request.post("/api/control", {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({ ...ACTOR, ...body }),
  });
  const payload = (await response.json()) as { error?: string };
  return { status: response.status(), error: payload.error ?? "" };
}

export async function planState(request: APIRequestContext) {
  const response = await request.get("/api/plan");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    placements: {
      gap_id: string;
      axis_scores: Record<string, number>;
      suggested_band: string;
      suggested_rationale: string;
      band: string | null;
      validated: boolean;
      rationale: string | null;
    }[];
    axes: {
      axes: { id: string; label: string; weight: number; cues: string[]; low_label: string; high_label: string; description: string }[];
      x_axis: string;
      y_axis: string;
      bands: { high: number; medium: number };
      updated_by: string;
    };
    proposals: {
      id: string;
      gap_id: string;
      name: string;
      status: string;
      tactic_id: string | null;
      decision_rationale: string | null;
    }[];
    timeline: {
      activities: {
        id: string;
        tactic_id: string;
        tactic_name: string;
        lane: string;
        start_date: string;
        end_date: string;
        readout_date: string | null;
        depends_on: string[];
        gap_ids: string[];
      }[];
      window: { start: string; end: string; months: number };
      lanes: { id: string; label: string; count: number }[];
      unscheduled: { gap_id: string }[];
    };
    plan: { version: number; status: string; saved_by: string; note: string | null } | null;
  };
}

export async function modulesState(request: APIRequestContext) {
  const response = await request.get("/api/modules");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    wiring: { stage: string; active: { id: string; version: string; agentic: boolean } | null; has_evals: boolean }[];
    runs: RunRecord[];
    routes: { stage: string; provider_id: string; model: string; fallbacks: string[] }[];
  };
}

export async function controlState(request: APIRequestContext) {
  const response = await request.get("/api/control");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    routes: { stage: string; provider_id: string; model: string; fallbacks: string[] }[];
    connections: {
      provider_id: string;
      label: string;
      tier: string | null;
      auth: string;
      configured: boolean;
      status: string;
      models: string[];
    }[];
    providers: { id: string; label: string; tier: string | null; auth: string; models: string[] }[];
    defaults: { primary: string; alternate: string };
    axes: { x_axis: string; y_axis: string };
  };
}

export async function runRecord(request: APIRequestContext, runId: string): Promise<RunRecord> {
  const response = await request.get(`/api/runs/${runId}`);
  expect(response.ok(), `run ${runId} should be readable`).toBeTruthy();
  const body = (await response.json()) as { run: RunRecord };
  return body.run;
}

export async function stageSignals(request: APIRequestContext, runId: string) {
  const response = await request.get(`/api/runs/${runId}?with=signals`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    run: RunRecord;
    edits: { rationale: string; field: string; action: string; entity_id: string; stage: string }[];
    signals: { rationale: string; kind: string; subject: string; stage: string }[];
    evals: { stage: string; metrics: EvalScore[]; passed: boolean }[];
  };
}

/**
 * A UI button click returns before the page repaints, and stage cards already show
 * older summaries, so specs wait on the run ledger rather than on page text.
 */
export async function runsForStage(request: APIRequestContext, stage: string) {
  const state = await modulesState(request);
  return state.runs.filter((run) => run.stage === stage && run.status === "ok");
}

/**
 * Waits for a newer successful run than the one identified by `previousId`. The
 * run ledger is a window over recent runs, so counting rows is unreliable; the
 * newest id is not.
 */
export async function waitForNewRun(
  request: APIRequestContext,
  stage: string,
  previousId: string | null,
): Promise<RunRecord> {
  await expect
    .poll(
      async () => {
        const runs = await runsForStage(request, stage);
        return runs[0]?.id ?? "none";
      },
      { timeout: 60_000, message: `expected a newer successful ${stage} run` },
    )
    .not.toBe(previousId ?? "none");
  return (await runsForStage(request, stage))[0]!;
}

export async function newestRunId(request: APIRequestContext, stage: string): Promise<string | null> {
  return (await runsForStage(request, stage))[0]?.id ?? null;
}

/**
 * Clicks a stage's Run button on the pipeline page and waits for the run ledger to
 * show it. Waits for hydration first: a click that lands before React attaches is
 * swallowed silently.
 */
export async function clickRunStage(
  page: Page,
  request: APIRequestContext,
  stage: string,
): Promise<RunRecord> {
  const before = await newestRunId(request, stage);
  await page.goto("/pipeline");
  const button = page.getByRole("button", { name: new RegExp(`^run ${stage}$`, "i") });
  await expect(button).toBeEnabled();
  await button.click();
  return waitForNewRun(request, stage, before);
}

export function evalValue(result: { evals: EvalScore[] } | RunRecord, name: string): number | undefined {
  return result.evals.find((score) => score.name === name)?.value;
}

export function exchangesOf(run: RunRecord): AgenticRoundRow[] {
  const step = run.steps.find((candidate) => candidate.name === "exchanges");
  return (step?.data as AgenticRoundRow[] | undefined) ?? [];
}

/**
 * The locked agentic shape: three proposer↔critic exchanges, each with a revision,
 * and the judge only after the last one.
 */
export async function expectThreeExchanges(request: APIRequestContext, runId: string) {
  const run = await runRecord(request, runId);
  const names = run.steps.map((step) => step.name);
  expect(names, `${run.stage} should open with a proposal`).toContain("round1:proposer");
  for (const round of [1, 2, 3]) {
    expect(names, `${run.stage} round ${round} critic`).toContain(`round${round}:critic`);
    expect(names, `${run.stage} round ${round} revision`).toContain(`round${round}:proposer-revise`);
  }
  expect(names).toContain("judge");
  expect(
    names.indexOf("judge"),
    `${run.stage} judge must come after the third exchange`,
  ).toBeGreaterThan(names.indexOf("round3:critic"));

  const rounds = exchangesOf(run);
  expect(rounds.map((round) => round.round)).toEqual([1, 2, 3]);
  expect(evalValue(run, "exchanges")).toBe(3);
  expect(run.evals.some((score) => score.name === "dialogue_retention")).toBeTruthy();
  expect(run.evals.some((score) => score.name === "critic_score_gain")).toBeTruthy();
  return { run, rounds };
}

/**
 * With no OAuth client configured the route must degrade to the deterministic
 * path and say why. The feature is still exercised, not skipped.
 */
export function expectRouteIsHonest(run: RunRecord) {
  expect(run.route, `${run.stage} should record its route`).toBeTruthy();
  if (run.route!.auth === "none") {
    expect(run.route!.provider_id).toBe("deterministic-local");
    expect(
      run.route!.reason ?? "",
      "the trace must say why it fell back to the deterministic route",
    ).toMatch(/not configured|disconnected|pending|no provider/i);
  } else {
    expect(run.route!.connected).toBeTruthy();
  }
}

export async function seedParsed(request: APIRequestContext, demo_ids = DEMO_SOURCES) {
  await resetWorkspace(request);
  const upload = await runStage(request, "S0", { demo_ids });
  const parse = await runStage(request, "S1");
  return { upload, parse };
}

export async function seedMapped(request: APIRequestContext, demo_ids = DEMO_SOURCES) {
  const seeded = await seedParsed(request, demo_ids);
  const gaps = await runStage(request, "S2");
  const tactics = await runStage(request, "S3");
  const mapping = await runStage(request, "S4");
  return { ...seeded, gaps, tactics, mapping };
}

export type ConsolidationOutput = {
  open: { gap_id: string; name: string; tactic_ids: string[] }[];
  addressed: { gap_id: string; name: string }[];
  unresolved_partials: { gap_id: string; name: string }[];
  flags: { code: string; gap_id: string | null; detail: string }[];
  ready_for_prioritization: boolean;
};

export async function consolidate(request: APIRequestContext) {
  return (await runStage<ConsolidationOutput>(request, "S7")).output;
}

export async function firstOpenGap(request: APIRequestContext) {
  const lists = await consolidate(request);
  expect(lists.open.length, "expected at least one open gap").toBeGreaterThan(0);
  return lists.open[0]!;
}

export async function firstPartialGap(request: APIRequestContext) {
  const lists = await consolidate(request);
  return lists.unresolved_partials[0] ?? null;
}

export async function validateBandHigh(request: APIRequestContext, gap_id: string, rationale: string) {
  return planAction(request, { action: "validate_band", gap_id, band: "high", rationale });
}
