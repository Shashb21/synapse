import { ensurePlatformSchema } from "./db";
import { RunRecorder, closeRun, openRun } from "./observability";
import { activeModule } from "./registry";
import { completionFor, resolveRoute, routeConfig } from "./routing";
import { DEFAULT_ROUTE_PROVIDER, findProvider } from "@/modules/llm/provider";
import { STAGES } from "./contracts";
import { recordSignal } from "./hillclimb";
import { recordEvalRun } from "./evals";
import type { Actor, EvalScore, ModuleContext, StageId } from "./contracts";
import { assertCan, type Capability, type Role } from "@/modules/auth/roles";

export const DEFAULT_WORKSPACE = "default";

/** Agentic stages require a connected LLM; mechanical stages may run without one. */
async function resolveRouteForRun(stage: StageId) {
  if (process.env.SYNAPSE_TEST_STUB_LLM === "1") {
    const preferred = await routeConfig(stage);
    const provider =
      findProvider(preferred.provider_id) ?? findProvider(DEFAULT_ROUTE_PROVIDER)!;
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: preferred.model || provider.default_model,
      auth: "oauth" as const,
      connected: true,
      params: preferred.params,
      fallbacks: preferred.fallbacks,
      degraded: false,
      reason: null,
    };
  }
  try {
    return await resolveRoute(stage);
  } catch (error) {
    if (STAGES[stage].kind === "agentic") throw error;
    const preferred = await routeConfig(stage);
    const provider =
      findProvider(preferred.provider_id) ?? findProvider(DEFAULT_ROUTE_PROVIDER)!;
    const message = error instanceof Error ? error.message : String(error);
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: preferred.model || provider.default_model,
      auth: "oauth" as const,
      connected: false,
      params: preferred.params,
      fallbacks: preferred.fallbacks,
      degraded: true,
      reason: message,
    };
  }
}

export type StageRunResult<O> = {
  run_id: string;
  stage: StageId;
  module_id: string;
  module_version: string;
  mode: "llm" | "deterministic";
  summary: string;
  output: O;
  evals: EvalScore[];
};

const CAPABILITY_BY_STAGE: Record<StageId, Capability> = {
  S0: "upload",
  S1: "upload",
  S2: "run_stage",
  S3: "run_stage",
  S4: "run_stage",
  S5: "validate",
  S6: "validate",
  S7: "run_stage",
  S8: "prioritize",
  S9: "ideate",
  S10: "export",
};

/**
 * The one way a stage is invoked. It resolves the active module, enforces the
 * caller's role, resolves routing, records the run, validates both ends of the
 * contract, and files evals and hillclimb signals.
 */
export async function runStage<O = unknown>(args: {
  stage: StageId;
  input: unknown;
  actor: Actor;
  role: Role;
  workspace_id?: string;
}): Promise<StageRunResult<O>> {
  assertCan(args.role, CAPABILITY_BY_STAGE[args.stage]);
  const implementation = await activeModule(args.stage);
  await ensurePlatformSchema(implementation.migrations ?? []);

  const workspace_id = args.workspace_id ?? DEFAULT_WORKSPACE;
  const recorder = new RunRecorder({
    workspace_id,
    stage: args.stage,
    module_id: implementation.manifest.id,
    module_version: implementation.manifest.version,
    actor: args.actor,
    input: args.input,
  });
  await openRun(recorder);

  // A contract violation is itself observable, so the run is already open here.
  const parsedInput = implementation.inputSchema.safeParse(args.input);
  if (!parsedInput.success) {
    const message = `${implementation.manifest.id} rejected its input: ${parsedInput.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
      .join("; ")}`;
    await closeRun({ recorder, status: "error", error: message });
    throw new Error(message);
  }
  recorder.note("input:accepted", parsedInput.data);

  const route = await resolveRouteForRun(args.stage);
  recorder.note("route", route, route.degraded ? (route.reason ?? "degraded") : undefined);

  const ctx: ModuleContext = {
    workspace_id,
    actor: args.actor,
    role: args.role,
    run: recorder,
    route,
    complete: completionFor(route, recorder),
  };

  try {
    const result = await implementation.run(parsedInput.data as never, ctx);
    const parsedOutput = implementation.outputSchema.safeParse(result.output);
    if (!parsedOutput.success) {
      throw new Error(
        `${implementation.manifest.id} produced output outside its contract: ${parsedOutput.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const evals = result.evals ?? [];
    await closeRun({
      recorder,
      status: "ok",
      summary: result.summary,
      output: parsedOutput.data,
      route,
      evals,
    });
    if (evals.length > 0) {
      await recordEvalRun({
        stage: args.stage,
        module_id: implementation.manifest.id,
        module_version: implementation.manifest.version,
        run_id: recorder.id,
        metrics: evals,
        note: result.summary,
      });
    }
    for (const signal of result.signals ?? []) {
      await recordSignal(signal);
    }
    const modeStep = recorder.steps().find((step) => step.name === "proposer:llm");
    return {
      run_id: recorder.id,
      stage: args.stage,
      module_id: implementation.manifest.id,
      module_version: implementation.manifest.version,
      mode: modeStep ? "llm" : "deterministic",
      summary: result.summary,
      output: parsedOutput.data as O,
      evals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeRun({ recorder, status: "error", error: message, route });
    throw error;
  }
}
