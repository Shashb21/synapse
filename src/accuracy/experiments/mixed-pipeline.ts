/** Isolated retained replay. Gold is used only by the existing version evaluator. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { registerAccuracyStack } from "@/accuracy";
import { withAssemblyExperiment } from "@/accuracy/kernel/assembly-context";
import type { Actor, CallKind, ResolvedAccuracyRoute } from "@/accuracy/kernel/contracts";
import { activeAccuracyModule } from "@/accuracy/kernel/registry";
import { accuracyRouteConfig, resolveAccuracyRoute } from "@/accuracy/kernel/routing";
import { runAccuracyModule, type AccuracyRunResult } from "@/accuracy/kernel/run";
import { reservedAccuracyRun } from "@/accuracy/kernel/observability";
import { readAgentProgression } from "@/accuracy/kernel/agent-events";
import { evaluateExperimentVersion } from "@/accuracy/eval/experiment-gold";
import { readParseBlocksByIds } from "@/accuracy/store/parse-store";
import { getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { getClaimsByIds, insertClaim, claimMetadata, listDownstreamClaims } from "@/accuracy/store/claim-store";
import { insertCoverageJoin, listCoverageJoins } from "@/accuracy/store/coverage-store";
import { checkAssembly, type ResolvedAssemblyItem } from "@/accuracy/domain/assembly";
import { provenanceSpanSchema, type ParseBlock } from "@/accuracy/store/quote-validator";
import { coverageDecisionSchema, coverageCriticOutputSchema } from "@/accuracy/modules/coverage-decide/schema";
import * as coveragePrompts from "@/accuracy/modules/coverage-decide/prompts";
import * as ideatePrompts from "@/accuracy/modules/ideate/prompts";
import { ideateOutputSchema } from "@/accuracy/modules/ideate/module";
import { asTacticLifecycle, deriveWorkspaceGapStatuses, type GapStatus } from "@/accuracy/modules/status-derive/engine";
import { projectGanttFromTactics, type GanttTacticInput } from "@/accuracy/modules/gantt-project/engine";
import { getExperiment, recordExperimentCall, recordVersionEvaluation } from "./records";
import { MIXED_GATE_POLICY, MIXED_GATE_POLICY_FINGERPRINT, MIXED_PIPELINE_STAGES, mixedCandidateEvidenceSchema,
  mixedStageEvidenceSchema, mixedFinalOutputsSchema, type MixedCandidateEvidence, type MixedGateDecision,
  type MixedSetupIdentity, type MixedStageEvidence, type MixedFinalOutputs } from "./mixed-types";

type Stage = typeof MIXED_PIPELINE_STAGES[number];
type Configuration = MixedSetupIdentity["configuration"];
type ModuleConfiguration = Configuration["modules"][number];
type Finding = MixedGateDecision["findings"][number];
const CHECKER = "mixed-deterministic-checks-v1";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function remapSelected(value: unknown, source: Record<string, string>, block: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map(child => remapSelected(child, source, block));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    typeof child === "string" && (key === "source_file_id" || key === "block_id") ? (key === "source_file_id" ? source : block)[child] ?? null : remapSelected(child, source, block)]));
  return value;
}
function promptIdentity(stage: Stage): string | null {
  const prompts = stage === "coverage_decide" || stage === "coverage_critic" ? coveragePrompts : stage === "ideate" ? ideatePrompts : null;
  return prompts ? hash(Object.fromEntries(Object.entries(prompts).map(([key, value]) => [key, typeof value === "function" ? value.toString() : value]))) : null;
}
function routeIdentity(route: ResolvedAccuracyRoute | null) {
  return route ? { provider_id: route.provider_id, model: route.model, role: route.role, auth: route.auth,
    connected: route.connected, params: route.params, fallbacks: route.fallbacks, degraded: route.degraded } : null;
}
/** Match kernel routing, including its explicit test-only fallback. Never makes a completion. */
async function settings(stage: Stage): Promise<ModuleConfiguration> {
  if (stage === "inventory_validate") return { stage, module_id: CHECKER, module_version: "1", prompt_version: null, model: null,
    parameters: { policy: MIXED_GATE_POLICY, checker: "assembly-domain-v1" } };
  const kind = stage as CallKind;
  const implementation = await activeAccuracyModule(kind);
  const role = implementation.manifest.agentic ? "proposer" : "none";
  const configured = await accuracyRouteConfig(kind, role);
  let route: ResolvedAccuracyRoute | null;
  try { route = await resolveAccuracyRoute({ call_kind: kind, agent_role: role }); }
  catch (error) {
    if (process.env.SYNAPSE_TEST_STUB_LLM !== "1" && implementation.manifest.agentic) throw error;
    route = process.env.SYNAPSE_TEST_STUB_LLM === "1" ? { call_kind: kind, role: role === "none" ? "proposer" : role,
      provider_id: "xai-grok", provider_label: "Grok (stub)", model: "stub", auth: "none", connected: false,
      params: { temperature: 0, max_tokens: 0 }, fallbacks: [], degraded: true, reason: "SYNAPSE_TEST_STUB_LLM" } : null;
  }
  return { stage, module_id: implementation.manifest.id, module_version: implementation.manifest.version, prompt_version: promptIdentity(stage), model: route?.model ?? null,
    parameters: { agentic: implementation.manifest.agentic, role, route: routeIdentity(route),
      configured_route: { provider_id: configured.provider_id, model: configured.model, params: configured.params, fallbacks: configured.fallbacks },
      behavior_fingerprint: hash(implementation.run.toString()), test_stub: process.env.SYNAPSE_TEST_STUB_LLM === "1",
      ...(stage === "coverage_critic" ? { enabled: true, applicability: "every_recomputed_pair" } : {}),
      ...(stage === "pair_generate" ? { pairing: "assembly-generation_all_selected_pairs_v1" } : {}),
      ...(stage === "validation_gate" ? { policy: MIXED_GATE_POLICY, policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT } : {}) } };
}
/** Capture once before either matched candidate runs; each call still validates actual mutable settings. */
export async function captureMixedPipelineConfiguration(): Promise<Configuration> {
  registerAccuracyStack();
  const modules = await Promise.all(MIXED_PIPELINE_STAGES.map(settings));
  return { fingerprint: hash(modules), modules };
}
class PipelineBlocker extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const blocked = (code: string, message: string): never => { throw new PipelineBlocker(code, message); };
const finding = (code: string, message: string, object_ids: string[], severity: Finding["severity"] = "blocking"): Finding => ({ code, message, object_ids, severity });

/** Accumulate evidence without editing the immutable selected payloads or source workspace. */
export async function runMixedCandidatePipeline(args: { evidence: MixedCandidateEvidence; actor: Actor; pack_id: string }): Promise<MixedCandidateEvidence> {
  if (args.evidence.status !== "pending") return structuredClone(args.evidence);
  const evidence = structuredClone(args.evidence);
  let stage: Stage = "inventory_validate";
  let currentCall: string | null = null;
  const calls: Partial<Record<Stage, Array<{ call_id: string; version_index: number }>>> = {};
  const results: Partial<Record<Stage, AccuracyRunResult<unknown>[]>> = {};
  const latency: Partial<Record<Stage, Array<number | null>>> = {};
  const attempt = evidence.attempt_id;
  const workspace = evidence.copied_workspace_id;
  const setup = evidence.setup;
  const original = evidence.original_assembly;
  const copy = evidence.copy;
  function replace(row: MixedStageEvidence) { evidence.stages = evidence.stages.filter(item => item.stage !== row.stage); evidence.stages.push(row); }
  function skip(name: Stage, reason: string) { replace({ stage: name, status: "skipped", applicable: false, input_count: 0, reason }); }
  function expected(name: Stage): ModuleConfiguration {
    const row = setup?.configuration.modules.find(row => row.stage === name);
    if (!row) blocked("configuration_drift", `Missing captured configuration for ${name}`);
    return row!;
  }
  async function check(name: Stage) {
    const actual = await settings(name);
    if (!isDeepStrictEqual(expected(name), actual)) blocked("configuration_drift", `Active settings changed for ${name}`);
  }
  async function retain(name: Stage, call_id: string, input: unknown, output: unknown, module_version: string, route: unknown, output_error?: string, version_index = 0) {
    const context = { workspace_id: workspace!, experiment_id: attempt! };
    const existing = await getExperiment(context);
    const previous = existing?.calls.find(row => row.call_id === call_id && row.version_index === version_index);
    if (previous && (!isDeepStrictEqual(previous.input, input) || !isDeepStrictEqual(previous.output, output ?? null) || previous.output_error !== (output_error ?? null))) {
      blocked("retained_identity_conflict", "Reserved retained call has different content");
    }
    const row = previous ?? await recordExperimentCall({ ...context, call_id, call_kind: name, version_index, input, output, output_error, module_version, route });
    const identity = { call_id, version_index };
    if (!(calls[name] ?? []).some(row => row.call_id === call_id && row.version_index === version_index)) (calls[name] ??= []).push(identity);
    if (!existing?.evaluations.some(row => row.call_id === call_id && row.version_index === version_index)) {
      await recordVersionEvaluation({ ...context, call_id, version_index, evaluation: evaluateExperimentVersion({ pack_id: args.pack_id,
        call_kind: name, output: row.output, ...(row.output_error ? { output_error: row.output_error } : {}) }) });
    }
  }
  function runId(name: Stage, key: string) { return `arun_mixed_${hash({ attempt, name, key }).slice(0, 40)}`; }
  async function artifact(name: Stage, input: unknown, output: unknown, key: string) {
    currentCall = runId(name, key);
    await retain(name, currentCall, input, output, expected(name).module_version, { kind: "deterministic_artifact", checker_version: CHECKER });
  }
  async function run<O>(name: Exclude<Stage, "inventory_validate">, input: Record<string, unknown>, key = "default"): Promise<AccuracyRunResult<O>> {
    stage = name;
    await check(name);
    const call_id = runId(name, key);
    currentCall = call_id;
    const configuration = expected(name);
    let result: AccuracyRunResult<O>;
    try {
      result = await runAccuracyModule<O>({ call_kind: name, reserved_run_id: call_id, input, actor: args.actor,
        org_id: (await getWorkspaceOrgId(workspace!))!, workspace_id: workspace!, evaluation_context: "experiment",
        agent_role: configuration.parameters.role === "none" ? "none" : "proposer" });
    } catch (error) {
      // Recovery is best effort; it must never replace the useful module error.
      try {
        const runtime = await reservedAccuracyRun(workspace!, call_id);
        const progression = await readAgentProgression({ workspace_id: workspace!, run_id: call_id });
        const snapshots = progression?.events.flatMap(row => row.event.event_type === "snapshot" ? [row.event.output] : []) ?? [];
        for (const [version_index, output] of snapshots.entries()) await retain(name, call_id, input, output, runtime?.module_version ?? configuration.module_version, runtime?.route ?? null, undefined, version_index);
        await retain(name, call_id, input, null, runtime?.module_version ?? configuration.module_version, runtime?.route ?? null,
          error instanceof Error ? error.message : String(error), snapshots.length);
      } catch { /* Earlier durable evidence remains available to the controller. */ }
      throw error;
    }
    (results[name] ??= []).push(result);
    // Reserve version 0 for native success before optional metadata reads. Snapshot
    // versions always start at 1, so metadata recovery cannot change retry identity.
    await retain(name, result.run_id, input, result.output, result.module_version, result.route);
    const progression = await readAgentProgression({ workspace_id: workspace!, run_id: result.run_id });
    const snapshots = progression?.events.flatMap(row => row.event.event_type === "snapshot" ? [row.event.output] : []) ?? [];
    for (const [index, output] of snapshots.entries()) await retain(name, result.run_id, input, output, result.module_version, result.route, undefined, index + 1);
    // Completed stage artifacts bind the native final output, even when snapshots
    // were appended later. Storage version identity remains independent of order.
    calls[name] = [...(calls[name] ?? []).filter(row => row.call_id !== result.run_id || row.version_index !== 0),
      { call_id: result.run_id, version_index: 0 }];
    const runtime = await reservedAccuracyRun(workspace!, result.run_id);
    const elapsed = runtime?.finished_at ? Date.parse(runtime.finished_at) - Date.parse(runtime.started_at) : NaN;
    (latency[name] ??= []).push(Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null);
    // Preserve the successful output first, including when mutable settings changed inside kernel execution.
    if (result.module_id !== configuration.module_id || result.module_version !== configuration.module_version ||
      !isDeepStrictEqual(routeIdentity(result.route), configuration.parameters.route)) blocked("configuration_drift", `Actual run settings differ for ${name}`);
    await check(name);
    return result;
  }
  function complete(name: Stage, output: unknown) {
    const config = expected(name);
    const actual = results[name] ?? [];
    const identities = calls[name] ?? [];
    const durations = latency[name] ?? [];
    replace(mixedStageEvidenceSchema.parse({ stage: name, status: "completed", output, run_ids: [...new Set(identities.map(row => row.call_id))], calls: identities,
      module_id: config.module_id, module_version: config.module_version, prompt_version: config.prompt_version, model: config.model,
      configuration_fingerprint: setup!.configuration.fingerprint,
      usage: { latency_ms: durations.length && durations.every(value => value !== null) ? durations.reduce<number>((sum, value) => sum + value!, 0) : null,
        input_tokens: actual.length ? actual.reduce((sum, row) => sum + row.token_usage.prompt_tokens, 0) : null,
        output_tokens: actual.length ? actual.reduce((sum, row) => sum + row.token_usage.completion_tokens, 0) : null,
        estimated_cost: actual.length ? actual.reduce((sum, row) => sum + row.cost_usd, 0) : null } }));
  }
  function gate(object_type: MixedGateDecision["object_type"], object_ids: string[], content: unknown, findings: Finding[], checked: unknown): MixedGateDecision {
    const content_fingerprint = hash(content);
    const check_fingerprint = hash({ checker: CHECKER, checked, findings });
    const decision = findings.some(row => row.severity === "blocking") ? "block" : "pass";
    const row: MixedGateDecision = { id: `gate_${hash({ attempt, object_type, object_ids, content_fingerprint, check_fingerprint })}`, policy: MIXED_GATE_POLICY,
      policy_fingerprint: MIXED_GATE_POLICY_FINGERPRINT, object_type, object_ids, content_fingerprint, check_fingerprint, checker_version: CHECKER,
      decision, rationale: decision === "pass" ? "Deterministic checks passed; content unchanged" : "Blocking deterministic findings; progression stopped", automatic: true, findings };
    evidence.gates.push(row);
    return row;
  }
  return withAssemblyExperiment(async () => {
    try {
      registerAccuracyStack();
      if (!attempt || !workspace || !setup || !original || !copy || workspace === original.workspace_id) blocked("incomplete_setup", "Candidate requires linked isolated copy and captured setup");
      if (setup!.gate_policy !== MIXED_GATE_POLICY || setup!.gate_policy_fingerprint !== MIXED_GATE_POLICY_FINGERPRINT || hash(setup!.configuration.modules) !== setup!.configuration.fingerprint) blocked("configuration_drift", "Captured policy/configuration fingerprint is invalid");
      await check(stage);
      const inventory = evidence.entry_source_inventory;
      const claims = inventory.map(row => row.claim_id);
      const blocks = await readParseBlocksByIds(workspace!, Object.values(copy!.block_id_map));
      const selectedItems = original!.items.map(item => {
        const selected = evidence.lineage.find(row => row.kind === "selected" && row.original_item_version_id === item.id);
        const entry = selected?.kind === "selected" ? inventory.find(row => row.claim_id === selected.copied_claim_id) : null;
        return { ...item, source_file_id: copy!.source_id_map[item.source_file_id], payload: entry?.payload ?? {} } as ResolvedAssemblyItem;
      });
      const report = checkAssembly({ items: selectedItems, source_file_ids: Object.values(copy!.source_id_map), blocks: blocks as ParseBlock[], mappings: [], coverage: [], linking_complete: false });
      // Linking is checked after recomputation; entry validation checks inventory only.
      const findings: Finding[] = report.findings.filter(row => row.code !== "linking_incomplete").map(row => finding(row.code, row.message, row.item_version_ids.flatMap(id => {
        const selected = evidence.lineage.find(row => row.kind === "selected" && row.original_item_version_id === id);
        return selected?.kind === "selected" ? [selected.copied_claim_id] : [];
      }), row.severity));
      if (new Set(claims).size !== claims.length || claims.length !== original!.items.length || selectedItems.some(item => !inventory.some(row => row.original_item_version_ids.includes(item.id)))) findings.push(finding("inventory_identity", "Inventory differs from exact selected versions", [...new Set(claims)]));
      for (const entry of inventory) {
        const selected = evidence.lineage.find(row => row.kind === "selected" && row.copied_claim_id === entry.claim_id);
        if (selected?.kind !== "selected" || !isDeepStrictEqual(selected.copied_payload, entry.payload)) findings.push(finding("payload_changed", "Copied payload differs from retained selected payload", [entry.claim_id]));
        if (selected?.kind === "selected") {
          const item = original!.items.find(item => item.id === selected.original_item_version_id);
          const originalProvenance = Array.isArray(item?.payload.provenance) ? item.payload.provenance.flatMap(span => {
            const parsed = provenanceSpanSchema.safeParse(span);
            if (!parsed.success) return [];
            const { source_file_id, block_id, quote } = parsed.data;
            return [{ source_file_id, block_id, quote }];
          }) : [];
          if (!isDeepStrictEqual(entry.original_provenance, originalProvenance)) findings.push(finding(
            "original_provenance_mismatch", "Inventory provenance differs from exact preserved selected payload provenance", [entry.claim_id]));
          const payload = item && remapSelected(item.payload, copy!.source_id_map, copy!.block_id_map) as Record<string, unknown> | undefined;
          const expectedPayload = payload && (Object.hasOwn(item!.payload, "id") ? { ...payload, id: entry.claim_id } : payload);
          if (!item || !isDeepStrictEqual(item.payload, selected.original_payload) || !isDeepStrictEqual(expectedPayload, entry.payload) ||
            copy!.claim_id_map[item.claim_id] !== entry.claim_id || item.claim_type !== entry.claim_type ||
            item.run_id !== selected.original_run_id || item.claim_id !== selected.original_claim_id || item.snapshot_id !== selected.original_snapshot_id ||
            item.iteration !== selected.original_iteration || item.item_index !== selected.original_item_index || item.reason !== selected.selection_reason ||
            !isDeepStrictEqual(entry.original_item_version_ids, [item.id])) findings.push(finding("original_lineage_mismatch", "Selected original/copy payload or run lineage differs", [entry.claim_id]));
        }
      }
      const durableClaims = await listDownstreamClaims(workspace!, { limit: claims.length + 1 });
      if (durableClaims.length !== claims.length || durableClaims.some(row => !claims.includes(row.id))) findings.push(finding("candidate_inventory_drift", "Copied inventory contains missing or unselected claims", claims));
      for (const entry of inventory) {
        const durable = durableClaims.find(row => row.id === entry.claim_id);
        if (!durable || durable.claim_type !== entry.claim_type || durable.statement !== (entry.claim_type === "gap" ? entry.payload.statement : entry.payload.name) ||
          Object.entries(entry.payload).some(([key, value]) => !isDeepStrictEqual(claimMetadata(durable)[key], value))) findings.push(finding("durable_payload_drift", "Stored copied claim differs from exact selected content", [entry.claim_id]));
      }
      const advisory = original!.checks.findings.filter(row => row.severity === "advisory").map(row => finding(row.code, row.message, claims, "advisory"));
      findings.push(...advisory);
      const checks = { original_fingerprint: original!.fingerprint, copy, inventory, blocks };
      await artifact("inventory_validate", checks, { claim_ids: claims, findings }, "checks");
      for (const entry of inventory) gate("claim", [entry.claim_id], entry.payload, findings.filter(row => !row.object_ids.length || row.object_ids.includes(entry.claim_id)), checks);
      if (findings.some(row => row.severity === "blocking")) blocked("deterministic_gate_blocked", "Selected inventory failed deterministic checks");
      complete("inventory_validate", { claim_ids: claims, findings });
      // Claim validation is mechanical and changes only validation fields, never selected content.
      stage = "validation_gate";
      await run("validation_gate", { workspace_id: workspace, claim_ids: claims, action: "validate", rationale: MIXED_GATE_POLICY }, "selected");
      const validatedClaims = await listDownstreamClaims(workspace!, { limit: claims.length + 1 });
      if (validatedClaims.length !== claims.length || inventory.some(entry => {
        const row = validatedClaims.find(row => row.id === entry.claim_id);
        return !row || !row.validated || row.statement !== (entry.claim_type === "gap" ? entry.payload.statement : entry.payload.name) ||
          Object.entries(entry.payload).some(([key, value]) => !isDeepStrictEqual(claimMetadata(row)[key], value));
      })) blocked("validation_content_changed", "Validation did not preserve and validate the exact selected claims");
      const generated = (await run<{ pairs: Array<{ gap_id: string; tactic_id: string }> }>("pair_generate", { workspace_id: workspace })).output;
      const gaps = inventory.filter(row => row.claim_type === "gap");
      const tactics = inventory.filter(row => row.claim_type === "tactic");
      if (generated.pairs.some(pair => !gaps.some(row => row.claim_id === pair.gap_id) || !tactics.some(row => row.claim_id === pair.tactic_id)) || new Set(generated.pairs.map(pair => `${pair.gap_id}:${pair.tactic_id}`)).size !== generated.pairs.length) blocked("invalid_pair_binding", "Pair generator returned crossed or duplicate candidate identities");
      // Reuse assembly-generation's full selected gap × tactic linking behavior.
      // Its local pair module is currently an empty stub; retain that native call too.
      const pairs = { pairs: gaps.flatMap(gap => tactics.map(tactic => ({ gap_id: gap.claim_id, tactic_id: tactic.claim_id }))) };
      await artifact("pair_generate", { inventory, behavior: expected("pair_generate").parameters.pairing }, pairs, "selected-pairs");
      complete("pair_generate", pairs);
      const coverage: MixedFinalOutputs["coverage"] = [];
      const reviews: Array<{ coverage_id: string; output: ReturnType<typeof coverageCriticOutputSchema.parse> }> = [];
      for (const pair of pairs.pairs) {
        const gap = gaps.find(row => row.claim_id === pair.gap_id)!;
        const tactic = tactics.find(row => row.claim_id === pair.tactic_id)!;
        const gapLineage = evidence.lineage.find(row => row.kind === "selected" && row.copied_claim_id === gap.claim_id)!;
        const tacticLineage = evidence.lineage.find(row => row.kind === "selected" && row.copied_claim_id === tactic.claim_id)!;
        if (gapLineage.kind !== "selected" || tacticLineage.kind !== "selected") throw new PipelineBlocker("missing_selected_lineage", "Pair requires exact selected versions");
        const block_bundle_ids = [...new Set([...gap.original_provenance, ...tactic.original_provenance].map(span => copy!.block_id_map[span.block_id]))];
        const input = { workspace_id: workspace, ...pair, block_bundle_ids, selected_versions: {
          gap_version_id: gapLineage.original_item_version_id, tactic_version_id: tacticLineage.original_item_version_id,
          gap_payload: gap.payload, tactic_payload: tactic.payload } };
        const output = coverageDecisionSchema.parse((await run("coverage_decide", input, `${pair.gap_id}:${pair.tactic_id}`)).output);
        const errors: Finding[] = [];
        if (output.gap_id !== pair.gap_id || output.tactic_id !== pair.tactic_id || output.quote_block_ids.some(id => !block_bundle_ids.includes(id)) || (output.overall !== "not_relevant" && !output.quote_block_ids.length)) errors.push(finding("coverage_binding", "Coverage does not bind exact selected evidence", [pair.gap_id, pair.tactic_id]));
        const id = `cov_${hash({ attempt, pair })}`;
        // A later critic failure must not hide an already successful decision.
        complete("coverage_decide", { decisions: [...coverage, { id, ...output, validated: false }] });
        const review = coverageCriticOutputSchema.parse((await run("coverage_critic", { workspace_id: workspace, ...output }, id)).output);
        reviews.push({ coverage_id: id, output: review });
        complete("coverage_critic", { reviews });
        stage = "validation_gate";
        errors.push(...review.issues.map(issue => finding("coverage_critic_advisory", issue || "Coverage critic advisory", [pair.gap_id, pair.tactic_id], "advisory")));
        if (!review.accept && !review.issues.length) errors.push(finding("coverage_critic_advisory", "Model critic declined coverage", [pair.gap_id, pair.tactic_id], "advisory"));
        const checked = { input, blocks: blocks.filter(block => block_bundle_ids.includes(block.id)) };
        if (errors.some(row => row.severity === "blocking")) {
          gate("coverage", [id], output, errors, checked);
          blocked("deterministic_gate_blocked", "Coverage failed deterministic checks");
        }
        const previous = (await listCoverageJoins(workspace!)).filter(row => row.gap_id === pair.gap_id && row.tactic_id === pair.tactic_id);
        if (previous.length > 1 || previous.some(row => row.overall !== output.overall || row.rationale !== output.rationale || !row.validated)) blocked("retained_identity_conflict", "Existing copied coverage differs from recomputed decision");
        const stored = previous[0] ?? await insertCoverageJoin({ workspace_id: workspace!, ...pair, overall: output.overall, rationale: output.rationale, validated: true });
        gate("coverage", [stored.id], output, errors, checked);
        coverage.push({ id: stored.id, ...output, validated: true });
      }
      if (coverage.length) { complete("coverage_decide", { decisions: coverage }); complete("coverage_critic", { reviews: reviews.map((review, index) => ({ ...review, coverage_id: coverage[index].id })) }); }
      else { skip("coverage_decide", "No candidate pairs"); skip("coverage_critic", "No recomputed coverage"); }
      stage = "validation_gate";
      await artifact(stage, { gates: evidence.gates, policy: MIXED_GATE_POLICY }, { decisions: evidence.gates }, "decisions");
      complete(stage, { decisions: evidence.gates });
      const tacticStatus = tactics.map(row => ({ id: row.claim_id, status: row.payload.status }));
      async function derive(key: string) {
        const result = await run<{ statuses: MixedFinalOutputs["statuses"]; open: number; partial: number; addressed: number }>("status_derive", { workspace_id: workspace, gap_ids: gaps.map(row => row.claim_id), tactics: tacticStatus, coverages: coverage, persist: true }, key);
        const overrides: Record<string, GapStatus | null> = {};
        for (const gap of gaps) {
          const override = gap.payload.status_override;
          const value = override && typeof override === "object" && !Array.isArray(override) ? override.status : null;
          overrides[gap.claim_id] = value === "open" || value === "partial" || value === "addressed" ? value : null;
        }
        const computed = deriveWorkspaceGapStatuses({ gap_ids: gaps.map(row => row.claim_id), coverages: coverage,
          tactics: tacticStatus.flatMap(row => { const status = asTacticLifecycle(row.status); return status ? [{ id: row.id, status }] : []; }), overrides });
        if (!isDeepStrictEqual(result.output.statuses, computed) || result.output.open !== computed.filter(row => row.status === "open").length ||
          result.output.partial !== computed.filter(row => row.status === "partial").length || result.output.addressed !== computed.filter(row => row.status === "addressed").length) blocked("invalid_status_derivation", "Status output does not match exact validated coverage and tactic lifecycle");
        return result.output;
      }
      let status = await derive("initial");
      complete("status_derive", status);
      const residuals: MixedFinalOutputs["residuals"] = [];
      const partials = status.statuses.filter(row => row.status === "partial");
      if (partials.length) {
        for (const partial of partials) {
          const result = await run<{ addressed_gap_id: string; open_residual_gap_id: string }>("partial_split", { workspace_id: workspace, gap_id: partial.gap_id }, partial.gap_id);
          const durable = await getClaimsByIds(workspace!, [result.output.open_residual_gap_id]);
          const child = durable.find(row => row.id === result.output.open_residual_gap_id && row.claim_type === "gap" && claimMetadata(row).parent_gap_id === partial.gap_id);
          if (!child || inventory.some(row => row.claim_id === child.id)) blocked("missing_durable_residual", "Partial split did not create a durable residual with parent lineage");
          // Current production stub never reaches here. A future implementation must provide source-bound payload/evidence before automatic validation.
          blocked("unsupported_residual_gate", "Durable residual requires supported deterministic payload/provenance checks");
        }
        complete("partial_split", { residuals });
        status = await derive("after-split"); complete("status_derive", status);
      } else skip("partial_split", "No partial gaps");
      const eligible = status.statuses.filter(row => row.status !== "addressed").map(row => row.gap_id);
      let priorities: MixedFinalOutputs["priorities"] = [];
      if (eligible.length) {
        const result = await run<{ placements: MixedFinalOutputs["priorities"] }>("prioritize", { workspace_id: workspace, gap_ids: eligible });
        priorities = result.output.placements;
        const durable = await getClaimsByIds(workspace!, eligible);
        if (priorities.length !== eligible.length || new Set(priorities.map(row => row.gap_id)).size !== eligible.length || eligible.some(id => !priorities.some(row => row.gap_id === id)) || priorities.some(row => !durable.some(claim => claim.id === row.gap_id && claimMetadata(claim).priority_band === row.band))) blocked("missing_priority_placement", "Prioritize did not persist a placement for every applicable gap");
        gate("priority", eligible, priorities, [], { eligible, durable });
        complete("prioritize", { placements: priorities });
      } else skip("prioritize", "No open or partial gaps");
      let proposals: MixedFinalOutputs["proposals"] = [];
      const high = priorities.filter(row => row.band === "high" && status.statuses.some(status => status.gap_id === row.gap_id && status.status === "open"));
      if (high.length) {
        const input = { workspace_id: workspace, gaps: gaps.map(row => ({ id: row.claim_id, statement: row.payload.statement, status: status.statuses.find(status => status.gap_id === row.claim_id)?.status,
          priority_band: priorities.find(priority => priority.gap_id === row.claim_id)?.band ?? null, validated: true })), existing_tactic_names: tactics.map(row => row.payload.name) };
        const result = await run("ideate", input);
        const output = ideateOutputSchema.parse(result.output); proposals = output.proposals;
        const names = new Set(tactics.map(row => String(row.payload.name).trim().toLowerCase()));
        for (const proposal of proposals) {
          const id = `tac_mixed_${hash({ attempt, run_id: result.run_id, proposal }).slice(0, 40)}`;
          const errors = !high.some(row => row.gap_id === proposal.gap_id) || names.has(proposal.name.trim().toLowerCase()) ? [finding("invalid_proposal", "Proposal has ineligible parent or duplicate name", [id])] : [];
          gate("proposal", [id], proposal, errors, { input });
          if (errors.length) blocked("deterministic_gate_blocked", "Proposal failed deterministic checks");
          names.add(proposal.name.trim().toLowerCase());
          const previous = (await getClaimsByIds(workspace!, [id]))[0];
          if (previous && (previous.claim_type !== "tactic" || previous.statement !== proposal.name || Object.entries(proposal).some(([key, value]) => !isDeepStrictEqual(claimMetadata(previous)[key], value)))) blocked("retained_identity_conflict", "Generated proposal identity has different durable content");
          if (!previous) await insertClaim({ id, workspace_id: workspace!, claim_type: "tactic", statement: proposal.name, status: "proposed", validated: false, metadata: { ...proposal, parent_gap_id: proposal.gap_id } });
          evidence.lineage.push({ kind: "ideated", copied_claim_id: id, parent_claim_ids: [proposal.gap_id], run_id: result.run_id, stage: "ideate", payload: proposal, copied_evidence_ids: [] });
          await run("validation_gate", { workspace_id: workspace, claim_ids: [id], action: "validate", rationale: MIXED_GATE_POLICY }, id);
        }
        complete("ideate", output);
      } else skip("ideate", "No validated high-priority open gaps");
      const planInput = { workspace_id: workspace, tactics: tactics.map(row => ({ ...row.payload, id: row.claim_id, validated: true, tactic_type: row.payload.type })), coverages: coverage, gaps: gaps.map(row => ({ id: row.claim_id, validated: true })) };
      const plan = (await run<MixedFinalOutputs["plan"]>("gantt_project", planInput)).output;
      const projected = projectGanttFromTactics({ tactics: planInput.tactics as GanttTacticInput[], coverages: coverage, gaps: planInput.gaps });
      if (plan.workspace_id !== workspace || !isDeepStrictEqual(plan.activities, projected)) blocked("invalid_plan_binding", "Plan differs from deterministic projection of validated candidate inventory");
      if (plan.activities.length) gate("plan", plan.activities.map(row => row.id), plan, [], { input: planInput });
      complete("gantt_project", plan);
      stage = "validation_gate";
      await artifact(stage, { gates: evidence.gates, policy: MIXED_GATE_POLICY }, { decisions: evidence.gates }, "final-decisions");
      complete(stage, { decisions: evidence.gates });
      evidence.final_source_inventory = structuredClone(inventory);
      evidence.final_outputs = mixedFinalOutputsSchema.parse({ inventory, coverage, statuses: status.statuses, priorities, residuals, proposals, plan });
      return mixedCandidateEvidenceSchema.parse({ ...evidence, status: "completed", primary_error: null });
    } catch (error) {
      const status = error instanceof PipelineBlocker ? "blocked" : "failed";
      const primary_error = { phase: "pipeline" as const, code: error instanceof PipelineBlocker ? error.code : "stage_failed", message: error instanceof Error ? error.message : String(error), stage, call_id: currentCall };
      const retainedCalls = calls[stage] ?? [];
      replace({ stage, status, primary_error, calls: retainedCalls, run_ids: [...new Set(retainedCalls.map(row => row.call_id))] });
      return mixedCandidateEvidenceSchema.parse({ ...evidence, status, primary_error });
    }
  });
}
