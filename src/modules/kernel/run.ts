import { scopedWorkspaceId } from "@/modules/workspaces/context";
import { activeRevisionPointer, getPromptRevision } from "./prompt-revisions";
import { activePromptVersion, scopedPromptRevision, revisionCompletion } from "./prompt-variant";
import { ensurePlatformSchema } from "./db";
import { RunRecorder, closeRun, openRun } from "./observability";
import { activeModule } from "./registry";
import { completionFor, resolveRoute, routeConfig, stageLabel } from "./routing";
import { AI_OFF_MESSAGE, AiDisabledError, aiEnabled, aiSectionEnabled, platformAiEnabled } from "./ai-switch";
import { sectionOfStage } from "./ai-sections";
import { DEFAULT_ROUTE_PROVIDER, findProvider } from "@/modules/llm/provider";
import { STAGES } from "./contracts";
import { recordSignal } from "./hillclimb";
import { recordEvalRun } from "./evals";
import type { Actor, EvalScore, ModuleContext, ResolvedRoute, StageId } from "./contracts";
import { assertCan, type Capability, type Role } from "@/modules/auth/roles";
import { isTestStub } from "./llm";
import { tagStageError } from "./stage-errors";
import type { RunStep } from "./contracts";

export const DEFAULT_WORKSPACE = "default";

/** Agentic stages require a connected LLM; mechanical stages may run without one. */
export async function resolveRouteForRun(stage: StageId) {
  // Test stub only: modules swap the model for labelled local output, so the
  // route is marked connected without a real provider behind it.
  if (isTestStub()) {
    const preferred = await routeConfig(stage);
    const provider =
      findProvider(preferred.provider_id) ?? findProvider(DEFAULT_ROUTE_PROVIDER)!;
    return {
      stage,
      provider_id: provider.id,
      provider_label: provider.label,
      model: preferred.model || provider.default_model,
      auth: "api_key" as const,
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
      auth: "api_key" as const,
      connected: false,
      params: preferred.params,
      fallbacks: preferred.fallbacks,
      degraded: true,
      reason: message,
    };
  }
}

/** The route a run sees while AI is off: nothing to prompt, and it says why. */
async function aiOffRoute(stage: StageId): Promise<ResolvedRoute> {
  const preferred = await routeConfig(stage);
  const provider = findProvider(preferred.provider_id) ?? findProvider(DEFAULT_ROUTE_PROVIDER)!;
  return {
    stage,
    provider_id: provider.id,
    provider_label: provider.label,
    model: preferred.model || provider.default_model,
    auth: "none",
    connected: false,
    params: preferred.params,
    fallbacks: preferred.fallbacks,
    degraded: false,
    reason: AI_OFF_MESSAGE,
  };
}

/**
 * Whether a run's decisions came from a model. A stage that reports its own
 * `mode` is believed; otherwise any recorded `llm:*` completion step counts.
 */
export function runMode(output: unknown, steps: Pick<RunStep, "name">[]): "llm" | "deterministic" {
  if (output && typeof output === "object" && "mode" in output) {
    const mode = (output as { mode?: unknown }).mode;
    if (mode === "llm" || mode === "deterministic") return mode;
  }
  return steps.some((step) => step.name.startsWith("llm:")) ? "llm" : "deterministic";
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
  // Building the timeline writes the plan's activities: an edit, not an export (viewers only read and export).
  S10: "run_stage",
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
  /**
   * Admin AI harness only (KAN-54): run the stage's AI whatever the customer-facing
   * switches say, so a section can be tried before it is turned on. Needs a routed model.
   * It never overrides the platform master switch: with AI off for the platform, no model runs.
   */
  force_ai?: boolean;
}): Promise<StageRunResult<O>> {
  assertCan(args.role, CAPABILITY_BY_STAGE[args.stage]);
  const scopedWorkspace = await scopedWorkspaceId() ?? DEFAULT_WORKSPACE;
  if (args.workspace_id && args.workspace_id !== scopedWorkspace) throw new Error("Stage workspace does not match the authorised database scope.");
  const workspace_id = scopedWorkspace;
  const implementation = await activeModule(args.stage);
  await ensurePlatformSchema(implementation.migrations ?? []);
  // Refused before a run is opened: with AI off an AI stage is not a failure, it is off.
  // Each stage follows its section's admin switch (KAN-53); S7 and S10 have no section.
  const section = sectionOfStage(args.stage);
  const ai =
    args.force_ai === true
      ? await platformAiEnabled()
      : section
        ? await aiSectionEnabled(section)
        : await aiEnabled();
  const manifest = implementation.manifest;
  if (!ai && ((manifest.agentic && !manifest.ai_optional) || manifest.needs_ai)) {
    throw new AiDisabledError(stageLabel(args.stage));
  }

  const recorder = new RunRecorder({
    workspace_id,
    stage: args.stage,
    module_id: implementation.manifest.id,
    module_version: implementation.manifest.version,
    actor: args.actor,
    input: implementation.traceInput ? implementation.traceInput(args.input) : args.input,
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
  recorder.note("input:accepted", implementation.traceInput ? implementation.traceInput(parsedInput.data) : parsedInput.data);

  const route = ai ? await resolveRouteForRun(args.stage) : await aiOffRoute(args.stage);
  recorder.note("route", route, route.degraded ? (route.reason ?? "degraded") : undefined);

  const ctx: ModuleContext = {
    workspace_id,
    actor: args.actor,
    role: args.role,
    run: recorder,
    route,
    complete: ai
      ? completionFor(route, recorder)
      : async () => {
          throw new AiDisabledError(stageLabel(args.stage));
        },
    ai,
  };

  try {
    const pointer = await activeRevisionPointer(workspace_id, args.stage);
    const revision = pointer.revision_id ? await getPromptRevision(pointer.revision_id, workspace_id) : null;
    const selected = scopedPromptRevision() ?? { id: revision?.id ?? null, instruction: revision?.instruction_text ?? "" };
    ctx.complete = revisionCompletion(ctx.complete, selected.instruction);
    recorder.note("prompt:variant", { version: selected.id ?? activePromptVersion() });
    const isApply = !!(parsedInput.data as { apply?: unknown })?.apply;
    if (implementation.freeze && !isApply) ctx.replay = {
      evaluation: false, input: parsedInput.data, facts: await implementation.freeze(parsedInput.data),
      module_id: manifest.id, module_version: manifest.version, prompt_version: selected.id ?? activePromptVersion(),
    };
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
      // Provenance (KAN-90): the run that produced it, on behalf of whom.
      await recordSignal({ actor_name: args.actor.name, ...signal, source_run_id: signal.source_run_id ?? recorder.id });
    }
    return {
      run_id: recorder.id,
      stage: args.stage,
      module_id: implementation.manifest.id,
      module_version: implementation.manifest.version,
      mode: runMode(parsedOutput.data, recorder.steps()),
      summary: result.summary,
      output: parsedOutput.data as O,
      evals,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeRun({ recorder, status: "error", error: message, route });
    // So the response can say which step failed (and offer to re-run mapping, KAN-68).
    tagStageError(error, args.stage);
    throw error;
  }
}
