import { ProviderError } from "@/modules/llm/provider-error";
import { NoRouteError } from "@/modules/llm/provider";
import {
  claimRevisionBatch,
  refreshRevisionBatch,
  pairRegressed,
  sealRevisionBatch,
  releaseSealedBatch,
} from "./revision-attempts";
import { approvedEvaluationRoute } from "./approved-evaluation-route";
/** Compare two instructions against one frozen case set without running the live persistence wrapper. */
import { sql } from "drizzle-orm";
import type { Actor, EvalScore, ModuleContext, ResolvedRoute, StageId, SynapseModule } from "./contracts";
import { ensurePlatformSchema, sharedDb } from "./db";
import { activeRevisionPointer, getPromptRevision, getRevisionCohort } from "./prompt-revisions";
import { evidenceHash, frozenReplayCase, projectReplayDecision, type FrozenReplayCase } from "./decision-replay";
import { activeModule } from "./registry";
import { completionFor } from "./routing";
import { getRun, RunRecorder } from "./observability";
import { revisionCompletion, withPromptRevision } from "./prompt-variant";
import { withLearningExclusions } from "./decision-examples";
import { assertEvaluationRoute, withEvaluationIsolation } from "./evaluation-isolation";
import {
  lineageResolver,
  TARGET_STAGES,
  lineageGroups,
  REVISION_PROTOCOL,
  reservedTarget,
  routeIdentity,
  scoreHumanTarget,
  type ReservedTarget,
} from "./revision-policy";
import { TrustedApplicationError } from "./stage-errors";
import type { PromptRevision, RevisionCohort } from "./prompt-revisions";
export { routeIdentity } from "./revision-policy";
import { newId, nowIso } from "./ids";
import { getWorkspace } from "@/modules/workspaces/store";
import { DEFAULT_SCHEMA, DEFAULT_WORKSPACE_ID, runInWorkspace } from "@/modules/workspaces/context";
import { assertAiEnabled } from "./ai-switch";
import { sectionOfStage } from "./ai-sections";
import { isTestStub } from "./llm";
export type CountedMetric = EvalScore & {
  numerator: number;
  denominator: number;
};
export type EvaluationArm = {
  gold: CountedMetric[];
  replay: CountedMetric[];
  gold_count: number;
  replay_count: number;
  gold_composite: number;
  replay_composite: number;
  combined: number;
};
export type EvaluationCall = {
  repeat?: number;
  arm: string;
  case_id: string;
  purpose: string;
  max_tokens: number;
  system_hash: string;
  user_hash: string;
};
export type RevisionEvaluation = {
  id: string;
  workspace_id: string;
  revision_id: string;
  stage: StageId;
  created_at: string;
  actor: Actor;
  baseline_revision_id: string | null;
  pointer_generation: number;
  module_id: string;
  module_version: string;
  route: ResolvedRoute;
  route_hash: string;
  cohort_id: string;
  case_hash: string;
  protocol?: typeof REVISION_PROTOCOL;
  targets?: ReservedTarget[];
  observations?: Observation[];
  calls: EvaluationCall[];
  gold_cases: unknown[];
  replay_ids: string[];
  excluded: Record<string, string>;
  allowed_example_ids: string[];
  baseline: EvaluationArm;
  candidate: EvaluationArm;
  retryable?: boolean;
  failures: string[];
  comparable: boolean;
  eligible: boolean;
  reasons: string[];
};
export type Observation = {
  arm: "baseline" | "candidate";
  case_id: string;
  repeat: number;
  snapshot_hash: string;
  target_hash: string;
  route_hash: string;
  revision_id: string | null;
  metrics: Record<string, number>;
};
export function summarizeObservations(rows: Observation[]): EvaluationArm {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const row of rows)
    for (const [name, value] of Object.entries(row.metrics)) {
      const total = totals.get(name) ?? { sum: 0, count: 0 };
      total.sum += value;
      total.count++;
      totals.set(name, total);
    }
  const gold = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, total]) => ({
      name,
      value: total.sum / total.count,
      numerator: total.sum,
      denominator: total.count,
      unit: "ratio" as const,
      detail: "Agreement with the reviewed target across paired observations",
    }));
  const numerator = gold.reduce((n, m) => n + m.numerator, 0),
    denominator = gold.reduce((n, m) => n + m.denominator, 0);
  const score = denominator ? numerator / denominator : 0;
  return {
    gold,
    replay: [],
    gold_count: new Set(rows.map((row) => row.case_id)).size,
    replay_count: 0,
    gold_composite: score,
    replay_composite: 0,
    combined: score,
  };
}

export function promotionEligibility(e: RevisionEvaluation): { eligible: boolean; reasons: string[] } {
  if (!e || !Array.isArray(e.calls) || !Array.isArray(e.failures) || !e.route || !e.baseline || !e.candidate)
    return { eligible: false, reasons: ["The stored evaluation is missing routing, call or score evidence."] };
  const reasons = new Set<string>();
  const fail = (reason: string) => {
    reasons.add(reason);
  };
  if (
    !e.protocol ||
    evidenceHash(e.protocol) !== evidenceHash(REVISION_PROTOCOL) ||
    !Array.isArray(e.targets) ||
    !Array.isArray(e.observations)
  )
    return {
      eligible: false,
      reasons: ["Generate a new candidate with independent reviewed targets and repeated paired observations."],
    };
  try {
    assertEvaluationRoute(e.route);
  } catch {
    fail("The evaluated route was unavailable, degraded or a recording.");
  }
  if (!e.comparable || e.failures.length || e.route_hash !== routeIdentity(e.route) || e.route.stage !== e.stage)
    fail("Execution, route or lineage was incomparable.");
  const targets = e.targets,
    rows = e.observations;
  const stageMetrics: Partial<Record<StageId, string[][]>> = {
    S8: [["band_agreement"]],
  };
  if (
    targets.some((target) => !stageMetrics[e.stage]?.some((names) => evidenceHash(names) === evidenceHash(target.metrics)))
  )
    fail("The cohort includes metrics outside the declared human-target contract.");
  if (
    targets.length < REVISION_PROTOCOL.minimum_cases ||
    ["id", "run_id", "fingerprint"].some(
      (key) => new Set(targets.map((t) => t[key as keyof ReservedTarget])).size !== targets.length,
    )
  )
    fail("Independent human-reviewed cases are missing.");
  if (rows.length !== targets.length * REVISION_PROTOCOL.repeats * 2)
    fail("The number of paired observations differs from the reserved cohort.");
  const improved = new Set<string>();
  for (let repeat = 0; repeat < REVISION_PROTOCOL.repeats; repeat++) {
    let difference = 0,
      denominator = 0;
    for (const target of targets) {
      const pair = rows.filter((r) => r.case_id === target.id && r.repeat === repeat);
      const baseline = pair.find((r) => r.arm === "baseline"),
        candidate = pair.find((r) => r.arm === "candidate");
      if (pair.length !== 2 || !baseline || !candidate) {
        fail("A paired case or repeat is missing or duplicated.");
        continue;
      }
      for (const row of pair) {
        const calls = e.calls.filter((c) => c.arm === row.arm && c.case_id === target.id && c.repeat === repeat);
        if (
          !calls.length ||
          calls.some((c) => !c.system_hash || !c.user_hash || !c.purpose || c.max_tokens !== e.route.params.max_tokens)
        )
          fail("The model call trace is incomplete.");
        if (
          !target.id ||
          !target.fingerprint ||
          !target.run_id ||
          !target.snapshot_hash ||
          !target.target_hash ||
          row.snapshot_hash !== target.snapshot_hash ||
          row.target_hash !== target.target_hash ||
          row.route_hash !== e.route_hash ||
          row.revision_id !== (row.arm === "baseline" ? e.baseline_revision_id : e.revision_id) ||
          !target.metrics.length ||
          evidenceHash(Object.keys(row.metrics).sort()) !== evidenceHash([...target.metrics].sort())
        )
          fail("A paired observation has different prompts, facts, targets, metrics or routing.");
      }
      const first = (arm: string) => e.calls.find((c) => c.arm === arm && c.case_id === target.id && c.repeat === repeat);
      const leftCall = first("baseline"),
        rightCall = first("candidate");
      if (
        !leftCall ||
        !rightCall ||
        leftCall.user_hash !== rightCall.user_hash ||
        leftCall.max_tokens !== rightCall.max_tokens ||
        leftCall.purpose !== rightCall.purpose ||
        leftCall.system_hash === rightCall.system_hash
      )
        fail("The paired initial calls require identical inputs and settings and distinct instructions.");
      for (const name of target.metrics) {
        const left = baseline.metrics[name],
          right = candidate.metrics[name];
        if (![0, 1].includes(left) || ![0, 1].includes(right) || right < left)
          fail("A human-target observation is invalid or regressed.");
        if (right > left) improved.add(target.id);
        difference += right - left;
        denominator++;
      }
    }
    if (!denominator || difference / denominator < REVISION_PROTOCOL.margin)
      fail("Every repeat must improve by at least ten percentage points.");
  }
  if (improved.size < 2) fail("At least two independent reviewed cases must improve.");
  for (const arm of ["baseline", "candidate"] as const)
    if (evidenceHash(e[arm]) !== evidenceHash(summarizeObservations(rows.filter((r) => r.arm === arm))))
      fail("The stored summary disagrees with the paired observations.");
  return { eligible: !reasons.size, reasons: [...reasons] };
}

/** Direct stage computation: all facts/examples are supplied; no runs/evals/domain rows are persisted. */
export async function executeFrozenStage(args: {
  module: SynapseModule<unknown, unknown>;
  snapshot: FrozenReplayCase;
  route: ResolvedRoute;
  revision: {
    id: string | null;
    instruction: string;
  };
  actor: Actor;
  excluded_ids: string[];
  record_call?: (call: Omit<EvaluationCall, "arm" | "case_id">) => void;
}): Promise<unknown> {
  const { module, snapshot } = args;
  assertEvaluationRoute(args.route);
  if (args.route.stage !== snapshot.stage) throw new Error("Frozen case belongs to a different route.");
  if (snapshot.module_id !== module.manifest.id || snapshot.module_version !== module.manifest.version)
    throw new Error("Frozen case belongs to a different stage implementation.");
  if (!snapshot.facts.state || snapshot.stage !== module.manifest.stage)
    throw new Error("Frozen stage facts are incomplete.");
  if (
    (
      snapshot.input as {
        apply?: unknown;
      }
    )?.apply
  )
    throw new Error("A split apply command cannot be replayed.");
  const recorder = new RunRecorder({
    workspace_id: snapshot.workspace_id,
    stage: snapshot.stage,
    module_id: module.manifest.id,
    module_version: module.manifest.version,
    actor: args.actor,
    input: snapshot.input,
  });

  const complete = completionFor(args.route, recorder);
  const observed: typeof complete = async (call) => {
    args.record_call?.({
      purpose: call.purpose,
      max_tokens: call.maxTokens ?? args.route.params.max_tokens,
      system_hash: evidenceHash(call.system),
      user_hash: evidenceHash(call.user),
    });
    return complete(call);
  };
  const ctx: ModuleContext = {
    workspace_id: snapshot.workspace_id,
    actor: args.actor,
    role: "owner",
    run: recorder,
    route: args.route,
    ai: true,
    complete: revisionCompletion(observed, args.revision.instruction),
    replay: {
      evaluation: true,
      input: snapshot.input,
      facts: structuredClone(snapshot.facts),
      examples: [],
      module_id: module.manifest.id,
      module_version: module.manifest.version,
      prompt_version: args.revision.id ?? "v1.0-baseline",
    },
  };
  return withEvaluationIsolation(() =>
    withPromptRevision(args.revision, () =>
      withLearningExclusions(args.excluded_ids, async () => {
        const input = module.inputSchema.parse(structuredClone(snapshot.input));
        const result = await module.run(input, ctx);
        if (recorder.steps().some((step) => step.name.endsWith(":invalid-json") || step.name === "llm_call:unrecorded"))
          throw new Error("Incomplete or invalid model execution.");
        return module.outputSchema.parse(result.output);
      }),
    ),
  );
}
export function validateReservedCohort(cohort: RevisionCohort) {
  const gold = cohort.gold_reservation;
  if (
    gold?.version !== 2 ||
    !gold.targets ||
    !gold.policy ||
    evidenceHash(gold.policy) !== evidenceHash(REVISION_PROTOCOL) ||
    gold.targets.length < REVISION_PROTOCOL.minimum_cases ||
    gold.cases.length !== gold.targets.length ||
    evidenceHash(gold.targets.map((t) => t.id)) !== evidenceHash(cohort.heldout_ids)
  )
    throw new TrustedApplicationError("Generate a new candidate with independent human targets reserved before generation.");
  const held = new Set(cohort.heldout_ids),
    training = new Set(cohort.training_ids);
  const selected = cohort.examples.filter((row) => training.has(row.id));
  const resolve = lineageResolver(cohort.examples);
  const groups = lineageGroups(cohort.examples);
  if (
    held.size !== gold.targets.length ||
    selected.length !== training.size ||
    training.size < REVISION_PROTOCOL.minimum_reviewers ||
    selected.some(
      (row) => !row.actor_principal || !row.lesson || row.lesson_status !== "ok" || cohort.excluded_ids.includes(row.id),
    ) ||
    new Set(selected.map((row) => row.actor_principal!.trim().toLowerCase())).size !== training.size ||
    groups.some((group) => group.filter((row) => held.has(row.id) || training.has(row.id)).length > 1)
  )
    throw new TrustedApplicationError("Reserved human cases and reviewer lessons must have independent lineage.");
  return gold.targets.map((target, index) => {
    const example = cohort.examples.find((row) => row.id === target.id);
    const item = gold.cases[index];
    if (
      !example ||
      example.workspace_id !== cohort.workspace_id ||
      example.stage !== cohort.stage ||
      item.testCase.name !== target.id ||
      item.snapshot.workspace_id !== cohort.workspace_id ||
      item.snapshot.stage !== cohort.stage ||
      !resolve(example) ||
      !frozenReplayCase(example) ||
      evidenceHash({ ...frozenReplayCase(example), examples: [] }) !== target.snapshot_hash ||
      item.snapshot.examples.length ||
      evidenceHash(reservedTarget(example, item.snapshot)) !== evidenceHash(target) ||
      !target.metrics.length
    )
      throw new TrustedApplicationError("Frozen facts, route or human target lineage changed. Generate a new candidate.");
    return { target, example, snapshot: item.snapshot };
  });
}

export async function verifyGenerationReservation(revision: PromptRevision, cohort: RevisionCohort) {
  const generation = await getRun(revision.generation_run_id);
  const input = generation?.input as { reservation_hash?: string; cohort_id?: string } | undefined;
  if (
    !generation ||
    generation.workspace_id !== revision.workspace_id ||
    generation.stage !== revision.stage ||
    generation.status !== "ok" ||
    generation.module_id !== "learning.prompt-revision" ||
    input?.cohort_id !== cohort.id ||
    input?.reservation_hash !== evidenceHash(cohort.gold_reservation)
  )
    throw new TrustedApplicationError("The pre-generation reservation cannot be verified. Generate a new candidate.");
}

/** Freeze once, run both arms, persist immutable evidence; this never activates an instruction. */
export async function evaluatePromptRevision(args: {
  revision_id: string;
  workspace_id: string;
  actor: Actor;
}): Promise<RevisionEvaluation> {
  await ensurePlatformSchema();
  const revision = await getPromptRevision(args.revision_id, args.workspace_id);
  if (!revision) throw new Error("Unknown candidate in this workspace.");
  if (!TARGET_STAGES.some((stage) => stage === revision.stage))
    throw new TrustedApplicationError("This stage has no independently comparable human target.");
  const workspace = await getWorkspace(args.workspace_id);
  if (!workspace && args.workspace_id !== DEFAULT_WORKSPACE_ID) throw new Error("Unknown workspace.");
  return runInWorkspace({ workspace_id: args.workspace_id, schema: workspace?.schema_name ?? DEFAULT_SCHEMA }, async () => {
    await assertAiEnabled("Prompt evaluation", sectionOfStage(revision.stage) ?? undefined);
    const cohort = await getRevisionCohort(revision.cohort_id, args.workspace_id);
    if (!cohort) throw new Error("Frozen candidate cohort is missing.");
    const pointer = await activeRevisionPointer(args.workspace_id, revision.stage);
    const active = pointer.revision_id ? await getPromptRevision(pointer.revision_id, args.workspace_id) : null;
    const stageModule = await activeModule(revision.stage);
    if (!stageModule.freeze) throw new Error("Stage has no isolated facts contract.");
    const route = await approvedEvaluationRoute(revision.stage);
    const items = validateReservedCohort(cohort);
    await verifyGenerationReservation(revision, cohort);
    assertEvaluationRoute(route);
    const gold = cohort.gold_reservation!;
    const baselineId = pointer.revision_id;
    const baselineInstruction = active?.instruction_text ?? "";
    const hash = routeIdentity(route);
    const current = () =>
      routeIdentity(route) === gold.route_hash &&
      pointer.generation === gold.pointer_generation &&
      revision.parent_revision === (baselineId ?? "v1.0-baseline") &&
      gold.parent_revision === revision.parent_revision &&
      items.every(
        ({ snapshot }) =>
          snapshot.module_id === stageModule.manifest.id &&
          snapshot.module_version === stageModule.manifest.version &&
          snapshot.prompt_version === revision.parent_revision &&
          routeIdentity(snapshot.route) === hash,
      );
    if (isTestStub() || !current() || baselineInstruction.trim() === revision.instruction_text.trim())
      throw new TrustedApplicationError(
        "Use the approved primary model and distinct instructions on their original stage, parent and settings. Generate a new candidate if these changed.",
      );
    const claim = await claimRevisionBatch(args.workspace_id, revision.id);
    if ("bound" in claim) return claim.bound;
    const { attempt } = claim;
    const sealed = claim.sealed;
    let interrupted = sealed?.interrupted ?? false,
      disqualified = sealed?.disqualified ?? false;
    const calls: EvaluationCall[] = sealed?.calls ?? [],
      observations: Observation[] = sealed?.observations ?? [],
      failures: string[] = sealed?.failures ?? [];
    for (let repeat = 0; !sealed && repeat < REVISION_PROTOCOL.repeats && !failures.length; repeat++) {
      for (const { target, example, snapshot } of items) {
        const arms = repeat % 2 === 0 ? (["baseline", "candidate"] as const) : (["candidate", "baseline"] as const);
        for (const arm of arms) {
          const instruction =
            arm === "candidate"
              ? { id: revision.id, instruction: revision.instruction_text }
              : { id: baselineId, instruction: baselineInstruction };
          try {
            await refreshRevisionBatch(attempt);
            const before = calls.length;
            const output = await executeFrozenStage({
              module: stageModule,
              snapshot,
              route,
              revision: instruction,
              actor: args.actor,
              excluded_ids: cohort.excluded_ids,
              record_call: (call) => calls.push({ ...call, arm, case_id: target.id, repeat }),
            });
            if ((output as { mode?: string })?.mode !== "llm" || calls.length === before)
              throw new Error("No routed model judgement.");
            const metrics = scoreHumanTarget(example, projectReplayDecision(example, output));
            observations.push({
              arm,
              repeat,
              case_id: target.id,
              revision_id: instruction.id,
              route_hash: hash,
              snapshot_hash: target.snapshot_hash,
              target_hash: target.target_hash,
              metrics,
            });
          } catch (error) {
            interrupted =
              error instanceof ProviderError ||
              error instanceof NoRouteError ||
              (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
            failures.push(`${arm} repeat ${repeat + 1} case ${target.id}: ${String(error)}`);
            break;
          }
        }
        const pair = observations.filter((row) => row.case_id === target.id && row.repeat === repeat);
        const left = pair.find((row) => row.arm === "baseline"),
          right = pair.find((row) => row.arm === "candidate");
        if (left && right && pairRegressed(left, right)) {
          disqualified = true;
          await refreshRevisionBatch(attempt, { case_id: target.id, repeat });
        }
        if (failures.length) break;
      }
      if (!failures.length) {
        const scores = (arm: Observation["arm"]) =>
          summarizeObservations(observations.filter((row) => row.arm === arm && row.repeat === repeat)).combined;
        if (scores("candidate") - scores("baseline") + Number.EPSILON < REVISION_PROTOCOL.margin) {
          disqualified = true;
          await refreshRevisionBatch(attempt, { repeat, reason: "completed_repeat_below_margin" });
        }
      }
    }
    if (!sealed && (!interrupted || disqualified))
      await sealRevisionBatch(attempt, { calls, observations, failures, interrupted, disqualified });
    try {
      const after = await activeRevisionPointer(args.workspace_id, revision.stage);
      const finalRoute = await approvedEvaluationRoute(revision.stage).catch(() => null);
      const finalModule = await activeModule(revision.stage);
      const evidence: RevisionEvaluation = {
        id: newId("pre"),
        workspace_id: args.workspace_id,
        revision_id: revision.id,
        stage: revision.stage,
        created_at: nowIso(),
        actor: args.actor,
        baseline_revision_id: baselineId,
        pointer_generation: pointer.generation,
        module_id: stageModule.manifest.id,
        module_version: stageModule.manifest.version,
        route,
        route_hash: hash,
        cohort_id: cohort.id,
        case_hash: evidenceHash(gold),
        calls,
        protocol: REVISION_PROTOCOL,
        targets: gold.targets!,
        observations,
        gold_cases: gold.cases,
        replay_ids: [],
        excluded: cohort.replay_exclusions,
        allowed_example_ids: [],
        baseline: summarizeObservations(observations.filter((r) => r.arm === "baseline")),
        candidate: summarizeObservations(observations.filter((r) => r.arm === "candidate")),
        failures,
        comparable:
          !!finalRoute &&
          !finalRoute.degraded &&
          finalRoute.connected &&
          hash === routeIdentity(finalRoute) &&
          after.generation === pointer.generation &&
          after.revision_id === baselineId &&
          finalModule.manifest.id === stageModule.manifest.id &&
          finalModule.manifest.version === stageModule.manifest.version,
        eligible: false,
        reasons: [],
      };
      evidence.retryable = interrupted && !disqualified && evidence.comparable;
      Object.assign(evidence, promotionEligibility(evidence));
      await sharedDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompt-evaluation:${revision.id}`}))`);
        const saved = await tx.execute(sql`update prompt_revision_attempts set
        bound_id=case when ${!evidence.retryable} or regression is not null then ${evidence.id} else null end,token=null
        where workspace_id=${attempt.workspace} and revision_id=${attempt.revision} and token=${attempt.token} and bound_id is null returning bound_id`);
        if (!saved.length) throw new TrustedApplicationError("This evaluation lost its claim. Reload the candidate.");
        await tx.execute(
          sql`insert into prompt_revision_evaluations(id,workspace_id,revision_id,created_at,evidence) values(${evidence.id},${args.workspace_id},${revision.id},${evidence.created_at},${JSON.stringify(evidence)}::jsonb)`,
        );
        await tx.execute(sql`update prompt_revisions set state='evaluated' where id=${revision.id} and state='candidate'`);
      });
      return evidence;
    } catch (error) {
      // A database outage may also delay release. Expiry still recovers the recorded observations.
      await releaseSealedBatch(attempt).catch(() => undefined);
      throw error;
    }
  });
}
/** Workspace-bound immutable evaluation lookup. */
export async function getRevisionEvaluation(id: string, workspace_id: string): Promise<RevisionEvaluation | null> {
  await ensurePlatformSchema();
  const rows = await sharedDb().execute(
    sql`select evidence from prompt_revision_evaluations where id=${id} and workspace_id=${workspace_id}`,
  );
  return (rows[0]?.evidence as RevisionEvaluation) ?? null;
}
/** Report evidence metadata without exposing raw frozen workspace cases in list responses. */
export async function listRevisionEvaluations(workspace_id: string): Promise<Omit<RevisionEvaluation, "gold_cases">[]> {
  await ensurePlatformSchema();
  const rows = await sharedDb().execute(
    sql`select evidence - 'gold_cases' as evidence from prompt_revision_evaluations where workspace_id=${workspace_id} order by created_at desc`,
  );
  return rows.map((row) => {
    const evidence = row.evidence as RevisionEvaluation;
    return { ...evidence, ...promotionEligibility(evidence) };
  });
}
