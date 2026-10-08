/** Execute accuracy modules after input, tenant ownership, and omission pause checks. */
import { isDeepStrictEqual } from "node:util";
import { activeAccuracyModule } from "./registry";
import { AiDisabledError, aiEnabled } from "@/modules/kernel/ai-switch";
import { accuracyDb, accuracyTransactionActive, ensureAccuracySchema } from "../store/db";
import { AccuracyRunRecorder, closeAccuracyRun, openAccuracyRun, reservedAccuracyRun } from "./observability";
import {
  accuracyCompletionFor,
  resolveAccuracyRoute,
} from "./routing";
import type {
  AccuracyModuleContext,
  AgentRole,
  CallKind,
  CostEstimate,
  EvalScore,
  Actor,
  ResolvedAccuracyRoute,
  ExperimentCycleControl,
} from "./contracts";
import { validateExperimentCycleControl } from "./contracts";
import { estimateCostUsd } from "./cost";
import { getWorkspaceOrgId } from "../store/tenant";
import { assertAccuracyCanProgress } from "./omission-pause";
import { isTestStub } from "@/modules/kernel/llm";
import { applyMergeJudgment, captureMergeInputs, mergeDedupeModule, prepareMergeJudgment,
  type MergeInputs, type MergeJudgment } from "../modules/merge-dedupe/module";
import type { JsonCompletion, RunStep } from "./contracts";

function completionOutsideTransaction(complete: JsonCompletion): JsonCompletion {
  return async args => {
    if (accuracyTransactionActive()) throw new Error("Model completion must run outside every Accuracy transaction.");
    return complete(args);
  };
}

/** Trusted server preparation; never parsed from a module's client input. */
export type PreparedAccuracyMerge = {
  workspace_id: string; org_id: string; run_id: string; module_id: string; module_version: string;
  judgment: MergeJudgment; route: ResolvedAccuracyRoute | null; steps: RunStep[]; costs: CostEstimate[]; started_at: string;
};
import { assemblyExecutionScope, withAssemblyWorkspaceLock } from "./assembly-context";
import {
  approvedLiveInventory,
  revalidateApprovedLiveBindings,
  type ApprovedAssemblyBinding,
  type ApprovedLiveInventory,
} from "../store/assembly-review-store";
import { AssemblyReviewError } from "../domain/assembly-review";
import { resolveApprovedRunInput } from "./approved-input";

export type AccuracyRunResult<O> = {
  run_id: string;
  call_kind: CallKind;
  module_id: string;
  module_version: string;
  summary: string;
  output: O;
  evals: EvalScore[];
  cost_usd: number;
  token_usage: CostEstimate["usage"];
  route: ResolvedAccuracyRoute | null;
};

/**
 * Run a registered module within its verified workspace and record execution evidence.
 * @param args - Operation, module input, trusted workspace/organization, and actor.
 * @returns Validated output with the recorded run identity, costs, and evaluation.
 * @throws Error for invalid input or conflicting workspace/organization identity.
 * @throws AccuracyPausedError for downstream work with unresolved important omissions.
 */
export async function runAccuracyModule<O = unknown>(args: {
  call_kind: CallKind;
  reserved_run_id?: string;
  agent_role?: AgentRole | "none";
  input: unknown;
  actor: Actor;
  org_id: string;
  workspace_id: string;
  /** Internal boundary for isolated experiments; production remains the default. */
  evaluation_context?: "production" | "experiment";
  experiment_cycle_control?: ExperimentCycleControl;
  /** Internal merge-only boundary. HTTP handlers never forward these from client input. */
  merge_preparation?: MergeInputs;
  prepared_merge?: PreparedAccuracyMerge;
}): Promise<AccuracyRunResult<O>> {
  if (args.merge_preparation && accuracyTransactionActive()) throw new Error("Merge preparation cannot join an outer transaction.");
  const agent_role = args.agent_role ?? "proposer";
  const evaluation_context = args.evaluation_context ?? "production";
  const experiment_cycle_control = validateExperimentCycleControl(args.experiment_cycle_control, evaluation_context, args.call_kind);
  const implementation = await activeAccuracyModule(args.call_kind);
  if ((args.merge_preparation || args.prepared_merge) && (args.call_kind !== "merge_dedupe"
    || implementation.manifest.id !== mergeDedupeModule.manifest.id)) throw new Error("Prepared merge module identity conflicts.");
  if (args.merge_preparation && args.merge_preparation.workspace_id !== args.workspace_id) throw new Error("Merge preparation workspace identity conflicts.");
  if (args.prepared_merge && (args.prepared_merge.workspace_id !== args.workspace_id
    || args.prepared_merge.org_id !== args.org_id || args.prepared_merge.run_id !== args.reserved_run_id
    || args.prepared_merge.module_id !== implementation.manifest.id
    || args.prepared_merge.module_version !== implementation.manifest.version)) throw new Error("Prepared merge operation identity conflicts.");
  await ensureAccuracySchema(implementation.migrations ?? []);
  // The admin AI switch: with AI off, no agentic module runs at all.
  if (implementation.manifest.agentic && !(await aiEnabled(accuracyTransactionActive() ? accuracyDb() : undefined))) {
    throw new AiDisabledError(implementation.manifest.title);
  }

  const parsedInput = implementation.inputSchema.safeParse(args.input);
  if (!parsedInput.success) {
    throw new Error(parsedInput.error.issues.map((issue) => issue.message).join("; "));
  }
  const inputWorkspace = parsedInput.data && typeof parsedInput.data === "object"
    ? (parsedInput.data as Record<string, unknown>).workspace_id : undefined;
  if (inputWorkspace !== args.workspace_id) {
    throw new Error("Module input workspace_id must match the trusted workspace_id.");
  }
  const workspaceOrg = await getWorkspaceOrgId(args.workspace_id);
  if (!workspaceOrg || workspaceOrg !== args.org_id) {
    throw new Error("Workspace does not belong to the trusted organization.");
  }
  await assertAccuracyCanProgress(args.workspace_id, args.call_kind);
  const consumption = await assemblyConsumptionForRun(args.workspace_id, args.call_kind, evaluation_context);
  const consumedLiveInventory = consumption.kind === "managed" ? consumption.live : null;
  const consumedAssemblyBindings = consumedLiveInventory?.bindings ?? null;
  const runInput = await resolveApprovedRunInput({
    workspace_id: args.workspace_id,
    call_kind: args.call_kind,
    input: parsedInput.data,
    live: consumedLiveInventory,
  });

  if (args.reserved_run_id) {
    const existing = await reservedAccuracyRun(args.workspace_id, args.reserved_run_id);
    if (existing) {
      if (existing.call_kind !== args.call_kind || existing.org_id !== args.org_id
        || !isDeepStrictEqual(existing.input, runInput) || existing.status !== "ok") {
        throw new Error("Reserved run identity conflicts with this operation.");
      }
      if (consumedAssemblyBindings && !isDeepStrictEqual(existingAssemblyBindings(existing.steps), consumedAssemblyBindings)) {
        throw new AssemblyReviewError("conflict", "Reserved run was produced from a different approved assembly binding.");
      }
      await withAssemblyWorkspaceLock(args.workspace_id, () => revalidateConsumption(args.workspace_id, consumption));
      return { run_id: existing.id, call_kind: args.call_kind, module_id: existing.module_id,
        module_version: existing.module_version, summary: existing.summary ?? "", output: existing.output as O,
        evals: (existing.evals ?? []) as EvalScore[], cost_usd: Number(existing.cost_usd ?? 0),
        token_usage: (existing.token_usage as CostEstimate["usage"] | null) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        route: existing.route as ResolvedAccuracyRoute | null };
    }
  }
  const recorder = new AccuracyRunRecorder({
    org_id: args.org_id,
    workspace_id: args.workspace_id,
    call_kind: args.call_kind,
    agent_role,
    module_id: implementation.manifest.id,
    module_version: implementation.manifest.version,
    actor: args.actor,
    input: runInput,
    evaluation_context,
    experiment_cycle_control,
  }, args.reserved_run_id, args.prepared_merge?.started_at);
  if (!args.merge_preparation) await openAccuracyRun(recorder);
  if (args.prepared_merge) recorder.restorePreparation(args.prepared_merge.steps, args.prepared_merge.costs);

  if (!args.prepared_merge) recorder.note("input:accepted", runInput);
  if (consumedAssemblyBindings) recorder.note("assembly:approved-live-bindings", consumedAssemblyBindings);

  let route = null;
  try {
    if (args.prepared_merge) {
      route = args.prepared_merge.route;
    } else if (isTestStub()) {
      // Vitest / Playwright: allow agentic modules without a live provider.
      const stub = await resolveAccuracyRoute({
        call_kind: args.call_kind,
        agent_role: implementation.manifest.agentic ? agent_role : "none",
      }).catch(() => null);
      route = stub ?? {
        call_kind: args.call_kind,
        role: agent_role === "none" ? "proposer" : agent_role,
        provider_id: "xai-grok",
        provider_label: "Grok (stub)",
        model: "stub",
        auth: "none" as const,
        connected: false,
        params: { temperature: 0, max_tokens: 0 },
        fallbacks: [],
        degraded: true,
        reason: "SYNAPSE_TEST_STUB_LLM",
      };
      recorder.note("route", route);
    } else {
      route = await resolveAccuracyRoute({ call_kind: args.call_kind, agent_role });
      recorder.note("route", route);
    }
  } catch (error) {
    if (implementation.manifest.agentic) {
      const message = error instanceof Error ? error.message : String(error);
      if (!args.merge_preparation) await closeAccuracyRun({ recorder, status: "error", error: message });
      throw error;
    }
  }

  const costs: CostEstimate[] = [];
  const llmReady =
    route &&
    route.connected &&
    route.auth === "api_key" &&
    !isTestStub();
  const ctx: AccuracyModuleContext = {
    org_id: args.org_id,
    workspace_id: args.workspace_id,
    actor: args.actor,
    role: "medical_affairs",
    evaluation_context,
    run: recorder,
    route: route ?? {
      call_kind: args.call_kind,
      role: "none",
      provider_id: "none",
      provider_label: "None",
      model: "none",
      auth: "none",
      connected: false,
      params: { temperature: 0, max_tokens: 0 },
      fallbacks: [],
      degraded: false,
      reason: "mechanical",
    },
    complete: llmReady
      ? completionOutsideTransaction(accuracyCompletionFor({
          route: route!,
          run: recorder,
          onUsage: (usage, cost_usd) => {
            const c: CostEstimate = {
              provider_id: route!.provider_id,
              model: route!.model,
              usage,
              cost_usd,
              price_source: estimateCostUsd({
                provider_id: route!.provider_id,
                model: route!.model,
                usage,
              }).price_source,
            };
            costs.push(c);
            recorder.addCost(c);
          },
        }))
      : async () => {
          throw new Error(
            isTestStub()
              ? "LLM stub: complete should not run under SYNAPSE_TEST_STUB_LLM"
              : "LLM not available — set XAI_API_KEY or ANTHROPIC_API_KEY in the server environment",
          );
        },
    noteCost: (cost) => {
      costs.push(cost);
      recorder.addCost(cost);
    },
  };

  try {
    if (args.merge_preparation) {
      recorder.note("merge:prepared-inputs", { revision: args.merge_preparation.revision });
      const judgment = await prepareMergeJudgment(args.merge_preparation, ctx);
      const prepared: PreparedAccuracyMerge = { workspace_id: args.workspace_id, org_id: args.org_id,
        run_id: recorder.id, module_id: implementation.manifest.id, module_version: implementation.manifest.version,
        judgment, route, steps: recorder.steps(), costs, started_at: recorder.startedAtIso() };
      const summary = recorder.usageSummary();
      return { run_id: recorder.id, call_kind: args.call_kind, module_id: implementation.manifest.id,
        module_version: implementation.manifest.version, output: prepared as O, summary: "Merge judgment prepared",
        evals: [], ...summary, route };
    }
    const execute = async () => {
      const result = args.prepared_merge
        ? await applyMergeJudgment(await captureMergeInputs(args.workspace_id), args.prepared_merge.judgment, ctx)
        : await implementation.run(runInput, ctx);
      const parsedOutput = implementation.outputSchema.safeParse(result.output);
      if (!parsedOutput.success) {
        const message = parsedOutput.error.issues.map((i) => i.message).join("; ");
        await closeAccuracyRun({ recorder, status: "error", error: message, route });
        throw new Error(message);
      }
      return { result, parsedOutput };
    };
    const publish = async (summary: string, output: unknown, evals: EvalScore[] | undefined) => {
      await revalidateConsumption(args.workspace_id, consumption);
      await closeAccuracyRun({
        recorder,
        status: "ok",
        summary,
        output,
        route,
        evals,
      });
    };
    const { result, parsedOutput } = consumption.kind !== "exempt" && !implementation.manifest.agentic
      ? await withAssemblyWorkspaceLock(args.workspace_id, async () => {
          await revalidateConsumption(args.workspace_id, consumption);
          const executed = await execute();
          await publish(executed.result.summary, executed.parsedOutput.data, executed.result.evals);
          return executed;
        })
      : await execute();
    if (consumption.kind === "exempt" || implementation.manifest.agentic) {
      await withAssemblyWorkspaceLock(args.workspace_id, async () => {
        await publish(result.summary, parsedOutput.data, result.evals);
      });
    }
    const summary = recorder.usageSummary();
    return {
      run_id: recorder.id,
      call_kind: args.call_kind,
      module_id: implementation.manifest.id,
      module_version: implementation.manifest.version,
      summary: result.summary,
      output: parsedOutput.data as O,
      evals: result.evals ?? [],
      cost_usd: summary.cost_usd,
      token_usage: summary.token_usage,
      route,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!args.merge_preparation) await closeAccuracyRun({ recorder, status: "error", error: message, route });
    throw error;
  }
}

/** Use the ordinary kernel gates/routing/recorder without opening or applying a run. */
export async function prepareAccuracyMerge(args: { workspace_id: string; org_id: string; actor: Actor;
  run_id: string; inputs: MergeInputs; evaluation_context?: "production" | "experiment";
  prior?: PreparedAccuracyMerge }): Promise<PreparedAccuracyMerge> {
  const result = await runAccuracyModule<PreparedAccuracyMerge>({ ...args, call_kind: "merge_dedupe", agent_role: "judge",
    reserved_run_id: args.run_id, input: { workspace_id: args.workspace_id }, merge_preparation: args.inputs });
  const prepared = result.output;
  // Repreparing stale inputs spends again. Keep all successful paid attempts
  // under the same journal operation rather than losing their cost/evidence.
  const prior = args.prior;
  if (prior && prior.workspace_id === prepared.workspace_id && prior.org_id === prepared.org_id
    && prior.run_id === prepared.run_id) {
    prepared.steps = [...prior.steps, ...prepared.steps];
    prepared.costs = [...prior.costs, ...prepared.costs];
    prepared.started_at = prior.started_at ?? prepared.started_at;
  }
  return prepared;
}

function existingAssemblyBindings(steps: unknown): ApprovedAssemblyBinding[] | null {
  if (!Array.isArray(steps)) return null;
  const entry = steps.find((step) => step && typeof step === "object"
    && (step as { name?: unknown }).name === "assembly:approved-live-bindings");
  const data = entry && typeof entry === "object" ? (entry as { data?: unknown }).data : null;
  return Array.isArray(data) ? data as ApprovedAssemblyBinding[] : null;
}

const PRE_APPROVAL_CALL_KINDS = new Set<CallKind>([
  "upload",
  "parse",
  "inventory_extract",
  "need_extract",
  "completeness_audit",
]);

type AssemblyConsumption =
  | { kind: "exempt" }
  | { kind: "legacy" }
  | { kind: "managed"; live: ApprovedLiveInventory };

async function revalidateConsumption(workspace_id: string, consumption: AssemblyConsumption): Promise<void> {
  if (consumption.kind === "exempt") return;
  if (consumption.kind === "managed") return revalidateApprovedLiveBindings(workspace_id, consumption.live.bindings);
  // Legacy permission expires at the first applied production batch, including an unapproved head.
  if (await approvedLiveInventory(workspace_id)) {
    throw new AssemblyReviewError("conflict", "Legacy workspace entered managed mode before publication.");
  }
}

async function assemblyConsumptionForRun(
  workspace_id: string,
  call_kind: CallKind,
  evaluation_context: "production" | "experiment",
): Promise<AssemblyConsumption> {
  const scope = assemblyExecutionScope();
  if (evaluation_context === "experiment" || scope.kind === "experiment" || scope.kind === "preparation") return { kind: "exempt" };
  if (PRE_APPROVAL_CALL_KINDS.has(call_kind)) return { kind: "exempt" };
  const live = await approvedLiveInventory(workspace_id);
  return live ? { kind: "managed", live } : { kind: "legacy" };
}
