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
}): Promise<AccuracyRunResult<O>> {
  const agent_role = args.agent_role ?? "proposer";
  const evaluation_context = args.evaluation_context ?? "production";
  const experiment_cycle_control = validateExperimentCycleControl(args.experiment_cycle_control, evaluation_context, args.call_kind);
  const implementation = await activeAccuracyModule(args.call_kind);
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

  if (args.reserved_run_id) {
    const existing = await reservedAccuracyRun(args.workspace_id, args.reserved_run_id);
    if (existing) {
      if (existing.call_kind !== args.call_kind || existing.org_id !== args.org_id
        || !isDeepStrictEqual(existing.input, args.input) || existing.status !== "ok") {
        throw new Error("Reserved run identity conflicts with this operation.");
      }
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
    input: args.input,
    evaluation_context,
    experiment_cycle_control,
  }, args.reserved_run_id);
  await openAccuracyRun(recorder);

  recorder.note("input:accepted", parsedInput.data);

  let route = null;
  try {
    if (isTestStub()) {
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
      await closeAccuracyRun({ recorder, status: "error", error: message });
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
      ? accuracyCompletionFor({
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
        })
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
    const result = await implementation.run(parsedInput.data, ctx);
    const parsedOutput = implementation.outputSchema.safeParse(result.output);
    if (!parsedOutput.success) {
      const message = parsedOutput.error.issues.map((i) => i.message).join("; ");
      await closeAccuracyRun({ recorder, status: "error", error: message, route });
      throw new Error(message);
    }
    await closeAccuracyRun({
      recorder,
      status: "ok",
      summary: result.summary,
      output: parsedOutput.data,
      route,
      evals: result.evals,
    });
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
    await closeAccuracyRun({ recorder, status: "error", error: message, route });
    throw error;
  }
}
