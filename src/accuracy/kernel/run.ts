import { activeAccuracyModule } from "./registry";
import { AiDisabledError, aiEnabled } from "@/modules/kernel/ai-switch";
import { ensureAccuracySchema } from "../store/db";
import { AccuracyRunRecorder, closeAccuracyRun, openAccuracyRun } from "./observability";
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
} from "./contracts";
import { estimateCostUsd } from "./cost";
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
};

export async function runAccuracyModule<O = unknown>(args: {
  call_kind: CallKind;
  agent_role?: AgentRole | "none";
  input: unknown;
  actor: Actor;
  org_id: string;
  workspace_id: string;
}): Promise<AccuracyRunResult<O>> {
  const agent_role = args.agent_role ?? "proposer";
  const implementation = await activeAccuracyModule(args.call_kind);
  await ensureAccuracySchema(implementation.migrations ?? []);
  // The admin AI switch: with AI off, no agentic module runs at all.
  if (implementation.manifest.agentic && !(await aiEnabled())) {
    throw new AiDisabledError(implementation.manifest.title);
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
  });
  await openAccuracyRun(recorder);

  const parsedInput = implementation.inputSchema.safeParse(args.input);
  if (!parsedInput.success) {
    const message = parsedInput.error.issues.map((i) => i.message).join("; ");
    await closeAccuracyRun({ recorder, status: "error", error: message });
    throw new Error(message);
  }
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
    (route.auth === "oauth" || route.auth === "api_key") &&
    !isTestStub();
  const ctx: AccuracyModuleContext = {
    org_id: args.org_id,
    workspace_id: args.workspace_id,
    actor: args.actor,
    role: "medical_affairs",
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
              : "LLM not available — connect Grok or Claude in /control",
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
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeAccuracyRun({ recorder, status: "error", error: message, route });
    throw error;
  }
}
