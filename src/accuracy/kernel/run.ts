/** Execute accuracy modules after input, tenant ownership, and omission pause checks. */
import { isDeepStrictEqual } from "node:util";
import { activeAccuracyModule } from "./registry";
import { ensureAccuracySchema } from "../store/db";
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
import { assemblyExecutionScope, withAssemblyWorkspaceLock } from "./assembly-context";
import {
  approvedLiveInventory,
  revalidateApprovedLiveBindings,
  type ApprovedAssemblyBinding,
  type ApprovedLiveInventory,
} from "../store/assembly-review-store";
import { AssemblyReviewError } from "../domain/assembly-review";
import { asTacticLifecycle, normalizeCoverageOverall } from "../modules/status-derive/engine";
import { claimMetadata } from "../store/claim-store";

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
  const consumedLiveInventory = await approvedLiveInventoryForRun(args.workspace_id, args.call_kind, evaluation_context);
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
  }, args.reserved_run_id);
  await openAccuracyRun(recorder);

  recorder.note("input:accepted", runInput);
  if (consumedAssemblyBindings) recorder.note("assembly:approved-live-bindings", consumedAssemblyBindings);

  let route = null;
  try {
    if (process.env.SYNAPSE_TEST_STUB_LLM === "1") {
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
    process.env.SYNAPSE_TEST_STUB_LLM !== "1";
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
            process.env.SYNAPSE_TEST_STUB_LLM === "1"
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
    const execute = async () => {
      const result = await implementation.run(runInput, ctx);
      const parsedOutput = implementation.outputSchema.safeParse(result.output);
      if (!parsedOutput.success) {
        const message = parsedOutput.error.issues.map((i) => i.message).join("; ");
        await closeAccuracyRun({ recorder, status: "error", error: message, route });
        throw new Error(message);
      }
      return { result, parsedOutput };
    };
    const publish = async (summary: string, output: unknown, evals: EvalScore[] | undefined) => {
      if (consumedAssemblyBindings) {
        await revalidateApprovedLiveBindings(args.workspace_id, consumedAssemblyBindings);
      }
      await closeAccuracyRun({
        recorder,
        status: "ok",
        summary,
        output,
        route,
        evals,
      });
    };
    const { result, parsedOutput } = consumedAssemblyBindings && !implementation.manifest.agentic
      ? await withAssemblyWorkspaceLock(args.workspace_id, async () => {
          await revalidateApprovedLiveBindings(args.workspace_id, consumedAssemblyBindings);
          const executed = await execute();
          await publish(executed.result.summary, executed.parsedOutput.data, executed.result.evals);
          return executed;
        })
      : await execute();
    if (!consumedAssemblyBindings || implementation.manifest.agentic) {
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
    await closeAccuracyRun({ recorder, status: "error", error: message, route });
    throw error;
  }
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

async function approvedLiveInventoryForRun(
  workspace_id: string,
  call_kind: CallKind,
  evaluation_context: "production" | "experiment",
): Promise<ApprovedLiveInventory | null> {
  const scope = assemblyExecutionScope();
  if (evaluation_context === "experiment" || scope.kind === "experiment" || scope.kind === "preparation") return null;
  if (PRE_APPROVAL_CALL_KINDS.has(call_kind)) return null;
  return approvedLiveInventory(workspace_id);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]));
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : null;
}

function provenanceBlockIds(payload: Record<string, unknown>): string[] {
  const spans = Array.isArray(payload.provenance) ? payload.provenance : [];
  return [...new Set(spans.flatMap((span) => {
    const row = record(span);
    const block = row?.block_id;
    return typeof block === "string" && block.trim() ? [block] : [];
  }))];
}

function coverageBlockBundle(row: ApprovedLiveInventory["coverage"][number] | undefined): string[] {
  const dimensions = record(row?.dimensions);
  return stringArray(dimensions?.block_bundle_ids) ?? stringArray(dimensions?.quote_block_ids) ?? [];
}

async function resolveApprovedRunInput<I>(args: {
  workspace_id: string;
  call_kind: CallKind;
  input: I;
  live: ApprovedLiveInventory | null;
}): Promise<I> {
  if (!args.live) return args.input;
  if (args.call_kind === "coverage_decide") return resolveCoverageDecideInput(args.input, args.live) as I;
  if (args.call_kind === "status_derive") {
    validateStatusDeriveInput(args.input, args.live);
  }
  return args.input;
}

function resolveCoverageDecideInput(input: unknown, live: ApprovedLiveInventory): unknown {
  const data = record(input);
  if (!data) return input;
  const gapId = typeof data.gap_id === "string" ? data.gap_id : "";
  const tacticId = typeof data.tactic_id === "string" ? data.tactic_id : "";
  const gap = live.selected_items.find((item) => item.claim_id === gapId && item.claim_type === "gap");
  const tactic = live.selected_items.find((item) => item.claim_id === tacticId && item.claim_type === "tactic");
  if (!gap || !tactic) {
    throw new AssemblyReviewError("approval_required", "Coverage decision requires claims from the current approved assembly.");
  }
  const selected_versions = {
    gap_version_id: gap.item_version_id,
    tactic_version_id: tactic.item_version_id,
    gap_payload: gap.payload,
    tactic_payload: tactic.payload,
  };
  if (data.selected_versions !== undefined && !sameJson(data.selected_versions, selected_versions)) {
    throw new AssemblyReviewError("conflict", "Supplied selected versions differ from the current approved assembly.");
  }
  const coverage = live.coverage.find((row) => row.gap_id === gapId && row.tactic_id === tacticId);
  const approvedBundle = coverageBlockBundle(coverage);
  const resolvedBundle = approvedBundle.length > 0 ? approvedBundle : [...new Set([
    ...provenanceBlockIds(gap.payload),
    ...provenanceBlockIds(tactic.payload),
  ])];
  const suppliedBundle = stringArray(data.block_bundle_ids) ?? [];
  if (!sameJson(suppliedBundle, resolvedBundle)) {
    throw new AssemblyReviewError("conflict", "Supplied coverage evidence bundle differs from the current approved assembly.");
  }
  return { ...data, block_bundle_ids: resolvedBundle, selected_versions };
}

function validateStatusDeriveInput(input: unknown, live: ApprovedLiveInventory): void {
  const data = record(input);
  if (!data) return;
  const claims = new Map(live.claims.map((claim) => [claim.id, claim]));
  const coverage = new Map(live.coverage.map((row) => [`${row.gap_id}\u0000${row.tactic_id}`, row]));

  for (const id of stringArray(data.gap_ids) ?? []) {
    const claim = claims.get(id);
    if (!claim || claim.claim_type !== "gap") {
      throw new AssemblyReviewError("conflict", "Supplied gap IDs must match the current approved assembly.");
    }
  }
  const tactics = Array.isArray(data.tactics) ? data.tactics : [];
  for (const row of tactics) {
    const tactic = record(row);
    const id = typeof tactic?.id === "string" ? tactic.id : "";
    const status = typeof tactic?.status === "string" ? tactic.status : "";
    const claim = claims.get(id);
    if (!claim || claim.claim_type !== "tactic") {
      throw new AssemblyReviewError("conflict", "Supplied tactics must match the current approved assembly.");
    }
    const meta = claimMetadata(claim);
    const approvedStatus = asTacticLifecycle(meta.tactic_status) ?? asTacticLifecycle(claim.status);
    if (status !== approvedStatus) {
      throw new AssemblyReviewError("conflict", "Supplied tactic status differs from the current approved assembly.");
    }
  }
  const coverages = Array.isArray(data.coverages) ? data.coverages : [];
  for (const row of coverages) {
    const supplied = record(row);
    const gapId = typeof supplied?.gap_id === "string" ? supplied.gap_id : "";
    const tacticId = typeof supplied?.tactic_id === "string" ? supplied.tactic_id : "";
    const approved = coverage.get(`${gapId}\u0000${tacticId}`);
    if (!approved) {
      throw new AssemblyReviewError("conflict", "Supplied coverage must match the current approved assembly.");
    }
    const approvedOverall = normalizeCoverageOverall(approved.overall) ?? "not_relevant";
    const suppliedOverall = normalizeCoverageOverall(typeof supplied?.overall === "string" ? supplied.overall : "") ?? "not_relevant";
    if (suppliedOverall !== approvedOverall || supplied?.validated !== approved.validated) {
      throw new AssemblyReviewError("conflict", "Supplied coverage differs from the current approved assembly.");
    }
  }
}
