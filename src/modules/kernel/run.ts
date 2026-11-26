/** Execute a kernel stage and record its workspace result. */
import { stageInputVersion, staleStage, usesStagePublication } from "./stage-publication";
import { lockRelationships } from "@/lib/iegp/relationship-change";
import { withModelRun, currentModelRun } from "./model-run";
import { compareParsedSources } from "@/lib/ingest/compare-source";
import { sql } from "drizzle-orm";
import { currentSchemaName, inWorkspaceTransaction, withWorkspaceTransaction } from "@/lib/iegp/db";
import { ApiGuardError } from "@/modules/auth/api-guard";
import { scopedWorkspaceId } from "@/modules/workspaces/context";
import { activeRevisionPointer, getPromptRevision } from "./prompt-revisions";
import { activePromptVersion, scopedPromptRevision, revisionCompletion } from "./prompt-variant";
import { db, ensurePlatformSchema } from "./db";
import { RunRecorder, closeRun, openRun, withRunningRun, withRunningStagePublication } from "./observability";
import { activeModule } from "./registry";
import { completionFor, resolveRoute, routeConfig, stageLabel } from "./routing";
import { AI_OFF_MESSAGE, AiDisabledError, aiEnabled, aiSectionEnabled, platformAiEnabled } from "./ai-switch";
import { sectionOfStage } from "./ai-sections";
import { DEFAULT_ROUTE_PROVIDER, findProvider } from "@/modules/llm/provider";
import { STAGES } from "./contracts";
import { recordSignal } from "./hillclimb";
import { recordEvalRun } from "./evals";
import type { Actor, EvalScore, HillclimbSignalDraft, ModuleContext, ResolvedRoute, StageId } from "./contracts";
import { assertCan, type Capability, type Role } from "@/modules/auth/roles";
import { isTestStub } from "./llm";
import { tagStageError, TrustedApplicationError } from "./stage-errors";
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
type StageRunArgs<O> = {
  signal?: AbortSignal;
  stage: StageId;
  input: unknown;
  actor: Actor;
  role: Role;
  workspace_id?: string;
  /** Server-owned purpose supplied by the owner evaluation routes. */
  purpose?: ModuleContext["purpose"];
  /** Score an evaluation without publishing candidate rows into the live plan. */
  evaluation?: boolean;
  /** Persist an ingestion checkpoint with its verified stage output. */
  onCommit?: (output: O) => Promise<void>;
  /**
   * Admin AI harness only (KAN-54): run the stage's AI whatever the customer-facing
   * switches say, so a section can be tried before it is turned on. Needs a routed model.
   * It never overrides the platform master switch: with AI off for the platform, no model runs.
   */
  force_ai?: boolean;
  /** The ingestion checkpoint owner runs this write after its outer rollback. */
  deferFailureRecord?: (persist: () => Promise<void>) => void;
};

/** Run a stage under one cancellable model budget, inherited from an enclosing request. */
export function runStage<O = unknown>(args: StageRunArgs<O>): Promise<StageRunResult<O>> {
  return withModelRun(args.signal, () => executeStage<O>(args));
}

async function executeStage<O>(args: StageRunArgs<O>): Promise<StageRunResult<O>> {
  assertCan(args.role, CAPABILITY_BY_STAGE[args.stage]);
  const phased = usesStagePublication(args.stage);
  if (phased && inWorkspaceTransaction()) {
    throw new Error("Start this model stage outside a workspace transaction.");
  }
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

  let route: ResolvedRoute | null = null;
  let inputDiagnostic: string | null = null;
  let signals: HillclimbSignalDraft[] = [];
  const ingestStage = ["S0", "S1", "S2", "S3", "S4"].includes(args.stage);
  const ownsParseCommit = args.stage === "S1" && !args.onCommit && !inWorkspaceTransaction();

  const execute = async (assertLive: () => Promise<void>): Promise<StageRunResult<O>> => {
    // A contract violation is itself observable, so the run is already open here.
    const parsedInput = implementation.inputSchema.safeParse(args.input);
    if (!parsedInput.success) {
      inputDiagnostic = `${implementation.manifest.id} rejected its input: ${parsedInput.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`;
      // Schema diagnostics stay in the run record. Public guidance never reflects input.
      const needsRationale = args.stage === "S5" && parsedInput.error.issues.some(issue => issue.path[0] === "rationale");
      throw new TrustedApplicationError(needsRationale
        ? "Enter a rationale with at least 3 characters, then try again."
        : "Check the required fields and their values, then try again.");
    }
    recorder.note("input:accepted", implementation.traceInput ? implementation.traceInput(parsedInput.data) : parsedInput.data);

    route = ai ? await resolveRouteForRun(args.stage) : await aiOffRoute(args.stage);
    recorder.note("route", route, route.degraded ? (route.reason ?? "degraded") : undefined);

    const ctx: ModuleContext = {
      purpose: args.purpose,
      workspace_id,
      actor: args.actor,
      role: args.role,
      run: recorder,
      route,
      complete: ai
        ? completionFor(route, recorder, { beforeSend: assertLive })
        : async () => {
            throw new AiDisabledError(stageLabel(args.stage));
          },
      ai,
    };
    if (ingestStage && !phased) await lockIngestion();
    const writes: (() => Promise<void>)[] = [];
    if (phased) ctx.deferWrite = write => { writes.push(write); };

    const pointer = await activeRevisionPointer(workspace_id, args.stage);
    const revision = pointer.revision_id ? await getPromptRevision(pointer.revision_id, workspace_id) : null;
    const selected = scopedPromptRevision() ?? { id: revision?.id ?? null, instruction: revision?.instruction_text ?? "" };
    ctx.complete = revisionCompletion(ctx.complete, selected.instruction);
    recorder.note("prompt:variant", { version: selected.id ?? activePromptVersion() });
    const isApply = !!(parsedInput.data as { apply?: unknown })?.apply;
    const capture = async () => {
      const freeze = implementation.captureForRun ?? implementation.freeze;
      if (freeze && !isApply) {
        ctx.replay = {
          evaluation: args.evaluation === true, input: parsedInput.data, facts: await freeze(parsedInput.data),
          module_id: manifest.id, module_version: manifest.version, prompt_version: selected.id ?? activePromptVersion(),
        };
      }
      return phased ? stageInputVersion(args.stage) : undefined;
    };
    const version = phased ? await withWorkspaceTransaction(async () => {
      await db().execute(sql`set transaction isolation level repeatable read, read only`);
      if (ingestStage) await lockIngestion();
      return capture();
    }) : await capture();
    currentModelRun()?.check();
    const result = await implementation.run(parsedInput.data as never, ctx);
    currentModelRun()?.check();
    const validate = () => {
      const parsedOutput = implementation.outputSchema.safeParse(result.output);
      if (!parsedOutput.success) {
        throw new Error(
          `${implementation.manifest.id} produced output outside its contract: ${parsedOutput.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
            .join("; ")}`,
        );
      }
      return parsedOutput;
    };
    const validated = validate();
    const publish = async () => {
      await assertLive();
      currentModelRun()?.check();
      if (phased && !args.evaluation) {
        if (ingestStage) await lockIngestion();
        if (args.stage === "S4") await lockRelationships();
        if (await stageInputVersion(args.stage, true) !== version) throw staleStage();
        for (const write of writes) await write();
      }
      const parsedOutput = writes.length ? validate() : validated;
      const evals = result.evals ?? [];
      await closeRun({
        recorder,
        status: "ok",
        summary: result.summary,
        output: parsedOutput.data,
        route,
        evals,
      });
      signals = result.signals ?? [];
      await recordFollowUps(evals, result.summary);
      await args.onCommit?.(parsedOutput.data as O);
      await assertLive();
      currentModelRun()?.check();
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
    };
    return phased ? withWorkspaceTransaction(publish) : publish();
  };

  async function lockIngestion() {
    const schema = await currentSchemaName();
    const locked = await db().execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0)) as locked`);
    if (!locked[0]?.locked) throw new ApiGuardError(409, "ingest_busy", "An ingestion step or clear is still running. Wait for it to finish, then retry.");
  }

  async function recordFollowUps(evals: EvalScore[], summary: string) {
    if (evals.length > 0) {
      await recordEvalRun({
        stage: args.stage,
        module_id: implementation.manifest.id,
        module_version: implementation.manifest.version,
        run_id: recorder.id,
        metrics: evals,
        note: summary,
      });
    }
    for (const signal of signals) {
      // Provenance (KAN-90): the run that produced it, on behalf of whom.
      await recordSignal({ actor_name: args.actor.name, ...signal, source_run_id: signal.source_run_id ?? recorder.id });
    }
  }

  const closeFailedRun = (error: unknown) => {
    const message = inputDiagnostic ?? (error instanceof Error ? error.message : String(error));
    return closeRun({ recorder, status: "error", error: message, route });
  };
  let stageFailure: { error: unknown } | undefined;
  let outcome: { result: StageRunResult<O> } | { error: unknown };
  try {
    outcome = phased
      ? await withRunningStagePublication(recorder, async assertLive => ({ result: await execute(assertLive) }))
      : await withRunningRun(recorder, async assertLive => {
          // Ingestion owns the surrounding checkpoint and its failure write. For
          // standalone work, roll back only the stage savepoint before finalizing.
          if (args.deferFailureRecord) return { result: await execute(assertLive) };
          try {
            return { result: await withWorkspaceTransaction(() => execute(assertLive)) };
          } catch (error) {
            currentModelRun()?.cancel();
            stageFailure = { error };
            await closeFailedRun(error);
            return stageFailure;
          }
        });
  } catch (transactionError) {
    currentModelRun()?.cancel();
    const error = stageFailure ? stageFailure.error : transactionError;
    const persist = async () => {
      try {
        if (args.deferFailureRecord) {
          // The checkpoint rollback also removed the running row. Restore it
          // with the original ID and write the terminal state in one commit.
          await withWorkspaceTransaction(async () => {
            await openRun(recorder);
            await closeFailedRun(error);
          });
        } else {
          await closeFailedRun(error);
        }
      } catch {
        // A database failure while closing must not replace the stage's error.
        console.error("Could not finalize failed module run", { run_id: recorder.id, stage: args.stage });
      }
    };
    if (args.deferFailureRecord) args.deferFailureRecord(persist);
    else await persist();
    outcome = { error };
  }
  if ("error" in outcome) {
    tagStageError(outcome.error, args.stage);
    throw outcome.error;
  }
  const { result } = outcome;

  try {
    // Direct S1 runs own their commit; pipeline S1 is compared after its checkpoint commits.
    const isDryRun = Boolean(args.input && typeof args.input === "object" && "dry_run" in args.input && args.input.dry_run === true);
    if (ownsParseCommit && !isDryRun) {
      const output = result.output as { documents?: { source_id: string }[] };
      await compareParsedSources((output.documents ?? []).map(doc => doc.source_id), args.actor);
    }
    return result;
  } catch (error) {
    tagStageError(error, args.stage);
    throw error;
  }
}
