import { compareParsedSources } from "@/lib/ingest/compare-source";
import { diagnosticRequestIdentity, DiagnosticPreview, withinDiagnosticBudget, type RequestIdentity } from "./diagnostic-requests";
import type { ProviderRequestBudget } from "@/modules/llm/provider";
import { sql } from "drizzle-orm";
import { currentSchemaName, inWorkspaceTransaction, withWorkspaceTransaction } from "@/lib/iegp/db";
import { ApiGuardError } from "@/modules/auth/api-guard";
import { scopedWorkspaceId } from "@/modules/workspaces/context";
import { activeRevisionPointer, getPromptRevision } from "./prompt-revisions";
import { activePromptVersion, scopedPromptRevision, revisionCompletion } from "./prompt-variant";
import { db, ensurePlatformSchema } from "./db";
import { RunRecorder, closeRun, openRun } from "./observability";
import { activeModule } from "./registry";
import { completionFor, resolveRoute, routeConfig, stageLabel } from "./routing";
import { AI_OFF_MESSAGE, AiDisabledError, aiEnabled, aiSectionEnabled, platformAiEnabled } from "./ai-switch";
import { sectionOfStage } from "./ai-sections";
import { DEFAULT_ROUTE_PROVIDER, findProvider } from "@/modules/llm/provider";
import { STAGES } from "./contracts";
import { recordSignal } from "./hillclimb";
import { assertDiagnosticWorkspace, recordEvalRun, type EvalExecution } from "./evals";
import { assertEvaluationRoute, inEvaluationIsolation } from "./evaluation-isolation";
import { evidenceHash } from "./decision-replay";
import { routeIdentity } from "./revision-policy";
import type { Actor, EvalScore, ModuleContext, ResolvedRoute, StageId } from "./contracts";
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
  diagnostic?: {
    execution: EvalExecution;
    route_hash: string | null;
    prompt_hash: string | null;
    first_prompt_hash: string | null;
    transcript_hash: string | null;
  };
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
  /** Server-owned owner harness context. Never forwarded from request JSON. */
  diagnostic?: {
    group_id: string;
    module_id: string;
    module_version: string;
    facts?: Record<string, unknown>;
    route: ResolvedRoute | null;
    preview?: boolean;
    approved_first?: RequestIdentity;
    budget: ProviderRequestBudget;
  };
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
  const diagnostic = args.diagnostic;
  if (diagnostic || inEvaluationIsolation()) {
    const input = args.input as { dry_run?: boolean; persist?: boolean; apply?: unknown } | null;
    if (!diagnostic || !inEvaluationIsolation() || !args.workspace_id || !implementation.evals ||
        diagnostic.module_id !== implementation.manifest.id || diagnostic.module_version !== implementation.manifest.version ||
        input?.dry_run !== true || input.persist !== false || input.apply ||
        (implementation.freeze && !diagnostic.facts)) {
      throw new TrustedApplicationError("The diagnostic stage requires an isolated dry run in its original workspace.");
    }
    await assertDiagnosticWorkspace(workspace_id);
    if (diagnostic.route) assertEvaluationRoute(diagnostic.route);
    if (diagnostic.route && diagnostic.route.stage !== args.stage) throw new TrustedApplicationError("Diagnostic route changed.");
  }
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

  if (diagnostic && ai && !isTestStub() && !diagnostic.route && (manifest.agentic || manifest.needs_ai || manifest.ai_optional)) {
    throw new TrustedApplicationError("The diagnostic stage requires a verified primary model.");
  }
  const recorder = new RunRecorder({
    workspace_id,
    stage: args.stage,
    module_id: implementation.manifest.id,
    module_version: implementation.manifest.version,
    actor: args.actor,
    input: implementation.traceInput ? implementation.traceInput(args.input) : args.input,
  });
  // Live pages use module_runs as their latest stage output. Diagnostics own a separate case record.
  if (!diagnostic) await openRun(recorder);

  // A contract violation is itself observable, so the run is already open here.
  const parsedInput = implementation.inputSchema.safeParse(args.input);
  if (!parsedInput.success) {
    const message = `${implementation.manifest.id} rejected its input: ${parsedInput.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
      .join("; ")}`;
    if (!diagnostic) await closeRun({ recorder, status: "error", error: message });
    // Schema diagnostics stay in the run record. Public guidance never reflects input.
    const needsRationale = args.stage === "S5" && parsedInput.error.issues.some(issue => issue.path[0] === "rationale");
    throw new TrustedApplicationError(needsRationale
      ? "Enter a rationale with at least 3 characters, then try again."
      : "Check the required fields and their values, then try again.");
  }
  recorder.note("input:accepted", implementation.traceInput ? implementation.traceInput(parsedInput.data) : parsedInput.data);

  const route: ResolvedRoute = diagnostic
    ? diagnostic.route ?? {
        stage: args.stage, provider_id: "none", provider_label: isTestStub() ? "Test stub" : "Mechanical",
        model: "", auth: "none", connected: false, params: { temperature: 0, max_tokens: 0 },
        fallbacks: [], degraded: false, reason: "No diagnostic model calls.",
      }
    : ai ? await resolveRouteForRun(args.stage) : await aiOffRoute(args.stage);
  const requests: RequestIdentity[] = [];
  let firstPrompt: string | null = null;
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

  const execute = async (): Promise<StageRunResult<O>> => {
    let selected = scopedPromptRevision();
    if (!selected) {
      const pointer = await activeRevisionPointer(workspace_id, args.stage);
      const revision = pointer.revision_id ? await getPromptRevision(pointer.revision_id, workspace_id) : null;
      selected = { id: revision?.id ?? null, instruction: revision?.instruction_text ?? "" };
    }
    if (diagnostic) {
      const complete = ctx.complete;
      ctx.complete = async call => {
        if (isTestStub() || !diagnostic.route) throw new TrustedApplicationError("A synthetic diagnostic cannot call a provider.");
        const id = diagnosticRequestIdentity(call, route, ctx.execution_policy, requests.length === 0);
        if (diagnostic.preview) throw new DiagnosticPreview(id);
        if (!requests.length) {
          if (diagnostic.approved_first && diagnostic.approved_first.actual !== id.actual) {
            throw new TrustedApplicationError("The diagnostic request changed after preview.");
          }
          firstPrompt = id.wire;
        }
        requests.push(id);
        return complete({ ...call, requestBudget: withinDiagnosticBudget(diagnostic.budget, call.requestBudget) });
      };
      recorder.note("diagnostic:case", { group_id: diagnostic.group_id });
    }
    ctx.complete = revisionCompletion(ctx.complete, selected.instruction);
    recorder.note("prompt:variant", { version: selected.id ?? activePromptVersion() });
    const isApply = !!(parsedInput.data as { apply?: unknown })?.apply;
    if (implementation.freeze && !isApply) ctx.replay = {
      evaluation: !!diagnostic, input: parsedInput.data, facts: diagnostic?.facts ?? await implementation.freeze(parsedInput.data),
      module_id: manifest.id, module_version: manifest.version, prompt_version: selected.id ?? activePromptVersion(),
    };
    const result = await implementation.run(parsedInput.data as never, ctx);
    if (diagnostic?.approved_first && !firstPrompt) throw new TrustedApplicationError("The approved diagnostic request was never dispatched.");
    const parsedOutput = implementation.outputSchema.safeParse(result.output);
    if (!parsedOutput.success) {
      throw new Error(
        `${implementation.manifest.id} produced output outside its contract: ${parsedOutput.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
          .join("; ")}`,
      );
    }
    // Stage telemetry has no externally scored target. The harness scores the case separately.
    const evals = (result.evals ?? []).map(({ name, value, unit, detail }) => ({ name, value, unit, detail }));
    const execution: EvalExecution = isTestStub() ? "synthetic" : recorder.steps().some(s => s.name.startsWith("llm:")) || requests.length ? "routed" : "mechanical";
    if (!diagnostic) await closeRun({
      recorder,
      status: "ok",
      summary: result.summary,
      output: parsedOutput.data,
      route,
      evals,
    });
    if (!diagnostic && evals.length > 0) {
      await recordEvalRun({
        workspace_id, kind: "live_diagnostic", lineage: {
          execution, route_hash: execution === "routed" ? routeIdentity(route) : null, prompt_hash: null, case_hash: null,
        },
        stage: args.stage,
        module_id: implementation.manifest.id,
        module_version: implementation.manifest.version,
        run_id: recorder.id,
        metrics: evals,
        note: result.summary,
      });
    }
    for (const signal of diagnostic ? [] : result.signals ?? []) {
      // Provenance (KAN-90): the run that produced it, on behalf of whom.
      await recordSignal({ actor_name: args.actor.name, ...signal, source_run_id: signal.source_run_id ?? recorder.id });
    }
    return {
      run_id: recorder.id,
      stage: args.stage,
      module_id: implementation.manifest.id,
      module_version: implementation.manifest.version,
      ...(diagnostic ? { diagnostic: {
        execution, route_hash: requests.length ? routeIdentity(route) : null,
        prompt_hash: requests.length ? evidenceHash(requests.map(r => r.design)) : null,
        first_prompt_hash: firstPrompt,
        transcript_hash: requests.length ? evidenceHash(requests.map(r => r.actual)) : null,
      } } : {}),
      mode: runMode(parsedOutput.data, recorder.steps()),
      summary: result.summary,
      output: parsedOutput.data as O,
      evals,
    };
  };

  const ownsParseCommit = args.stage === "S1" && !inWorkspaceTransaction();
  const isDryRun = Boolean(args.input && typeof args.input === "object" && "dry_run" in args.input && args.input.dry_run === true);
  try {
    if (!diagnostic?.facts && ["S0", "S1", "S2", "S3", "S4"].includes(args.stage)) {
      // Freeze facts and every live ingestion write share clear's lock. The
      // pipeline already owns this lock: transaction locks are reentrant on
      // that connection, and nesting here creates a savepoint, not a new owner.
      const schema = await currentSchemaName();
      const result = await withWorkspaceTransaction(async () => {
        const locked = await db().execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`ingest:${schema}`}, 0)) as locked`);
        if (!locked[0]?.locked) throw new ApiGuardError(409, "ingest_busy", "An ingestion step or clear is still running. Wait for it to finish, then retry.");
        return execute();
      });
      // S1 owns this commit only for direct runs; the pipeline owns its outer commit.
      if (ownsParseCommit && !isDryRun) {
        const output = result.output as { documents?: { source_id: string }[] };
        await compareParsedSources((output.documents ?? []).map(doc => doc.source_id), args.actor);
      }
      return result;
    }
    return await execute();
  } catch (error) {
    // Standalone failures roll back current state before persisting their run
    // error. An outer pipeline transaction still owns its checkpoint and trace.
    const message = error instanceof Error ? error.message : String(error);
    if (!diagnostic) await closeRun({ recorder, status: "error", error: message, route });
    // So the response can say which step failed (and offer to re-run mapping, KAN-68).
    tagStageError(error, args.stage);
    throw error;
  }
}
