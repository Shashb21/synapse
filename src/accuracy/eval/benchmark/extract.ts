/** Isolated complete-source benchmark extraction with caller-owned authorization,
 * checkpoints and accounting. Uses single-attempt HTTP without loading provider env.
 */
import { anthropicSampling, anthropicAnswer } from "./anthropic-protocol";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parsedBlockSchema, type ParsedBlock } from "@/lib/schema";
import { TACTIC_STATUSES, TACTIC_TYPES } from "@/lib/iegp/enums";
import { NEED_PROPOSER_SYSTEM } from "../../modules/need-extract/prompts";
import { INVENTORY_PROPOSER_SYSTEM } from "../../modules/inventory-extract/prompts";
import { provenanceSpanSchema, validateQuoteAgainstBlock, type ProvenanceSpan } from "../../store/quote-validator";
import type { BaselineRouteSnapshot, BenchmarkRoute } from "./contracts";
import type { FrozenReferencePack } from "./inputs";
import type { LlmUsage } from "@/modules/llm/provider";

export type ExtractRequest = {
  runId: string; attemptId: string;
  /** Deliberately excludes gold; only explicitly selected source fields enter HTTP bodies. */
  pack: Pick<FrozenReferencePack, "packId" | "sourceHash" | "source">;
  route: BenchmarkRoute;
  projectId?: string;
  baseline?: { snapshot: BaselineRouteSnapshot; shallowCycle: boolean; baseUrl: string; headers?: Record<string, string> };
  resume?: ExtractState;
};
export type ExtractAttempt = {
  id: string; operation: "upload" | "submit" | "poll" | "baseline";
  startedAt: string; elapsedMs: number; httpStatus: number | null;
  status: "started" | "completed" | "failed";
  /** Unknown until the caller prices token usage or Extract bills credits. Never zero by default. */
  costUsd: number | null; usage: unknown;
  actualRoute?: ExtractResult["actualRoute"];
  error?: ExtractResult["error"];
};
export type ExtractState = {
  runId: string; sourceHash: string; settingsHash: string;
  contextHash: string;
  stage: BenchmarkRoute["stage"]; configuration: BenchmarkRoute["configuration"];
  uploadId: string | null; jobId: string | null; submissionUncertain: boolean;
  rawOutputs: unknown[]; attempts: ExtractAttempt[];
};
export type ExtractTransport = {
  /** Native fetch or a synthetic fetch. Exactly one invocation per recorded attempt. */
  fetch: typeof fetch; apiKey: string;
  /** Batch MUST approve budget/authorization and persist the started attempt before HTTP. */
  beforeAttempt: (attempt: ExtractAttempt, state: ExtractState) => Promise<void>;
  /** Awaited immediately after upload/submission/response; batch persists privately. */
  checkpoint: (state: ExtractState) => Promise<void>;
};
export type ExtractFinding = {
  id: string; statement: string; external_id: string | null;
  details: Record<string, unknown>; provenance: ProvenanceSpan[];
  citation: { valid: boolean; reasons: string[]; locations: ParsedBlock["location"][]; metadata: unknown };
};
export type ExtractResult = {
  status: "completed" | "pending" | "failed" | "blocked";
  runId: string; attemptId: string; state: ExtractState;
  findings: ExtractFinding[]; rawOutputs: unknown[]; attempts: ExtractAttempt[];
  actualRoute: { providerId: string | null; model: string | null; version: string | null; tier: string | null; label: "verified" | "unverified" | "substituted" };
  usage: unknown; costUsd: number | null; elapsedMs: number;
  error?: { code: string; temporary: boolean; httpStatus: number | null };
};

/** USD per credit, verified 2026-10-13 against official LlamaCloud pricing:
 * https://developers.llamaindex.ai/llamaparse/general/pricing/ ($1.25 / 1000 credits).
 */
const EXTRACT_USD_PER_CREDIT_2026_10_13 = 1.25 / 1000;

const need = z.object({ statement: z.string().min(1), external_id: z.string().nullable().optional(), provenance: z.array(provenanceSpanSchema).optional() });
const tactic = z.object({ name: z.string().min(1), type: z.enum(TACTIC_TYPES), status: z.enum(TACTIC_STATUSES), evidence_question: z.string().min(1), origin: z.literal("inventory"), external_id: z.string().nullable().optional(), provenance: z.array(provenanceSpanSchema).optional() });
const schemas = { need_extract: z.object({ gaps: z.array(need) }), inventory_extract: z.object({ tactics: z.array(tactic) }) };
/** Return an object view of unknown input, or an empty object. */
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Return nonempty string input, otherwise null. */
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
/** Return finite nonnegative numeric input, otherwise null. */
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
/** Return array input, otherwise an empty array. */
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Internal classified failure; public results expose only code, retryability and status. */
class StageError extends Error {
  constructor(readonly code: string, readonly temporary = false, readonly httpStatus: number | null = null) { super(code); }
}
/** Recursively redact supplied secrets from a JSON-like value; returns a detached value. */
function sanitize(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return secrets.filter(Boolean).reduce((s, secret) => s.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, secrets)]));
  return value;
}
/** Hash request content/settings for resume binding; JSON serialization errors propagate. */
function contextHash(request: ExtractRequest): string {
  // Bind resume to actual content and supplied settings, not just caller-attested hashes.
  return createHash("sha256").update(JSON.stringify({ runId: request.runId, packId: request.pack.packId, source: request.pack.source, route: request.route, baseline: request.baseline, projectId: request.projectId })).digest("hex");
}
/** Serialize every request source block with its original markers; returns untruncated text. */
function sourceText(request: ExtractRequest): string {
  return [`source_file_id=${request.pack.packId}`, ...request.pack.source.blocks.map((b) => `### block_id=${b.id}${b.heading ? ` · ${b.heading}` : ""}\nlocation=${JSON.stringify(b.location)}\n${b.text}`)].join("\n\n");
}
/** Validate request source, route and resume binding; returns void or throws StageError. */
function validateRequest(request: ExtractRequest): void {
  if (!request.runId || !request.attemptId || !request.pack.sourceHash || !request.pack.packId) throw new StageError("invalid_request");
  const blocks = z.array(parsedBlockSchema).min(1).safeParse(request.pack.source.blocks);
  if (!blocks.success || new Set(request.pack.source.blocks.map((b) => b.id)).size !== request.pack.source.blocks.length) throw new StageError("invalid_source");
  const r = request.route;
  if (r.stage !== "need_extract" && r.stage !== "inventory_extract") throw new StageError("unsupported_stage");
  if (!r.authorizationEvidence) throw new StageError("authorization_missing");
  if (r.configuration === "extract") {
    if (r.version !== "2.5" || !["cost_effective", "agentic", "agentic_plus"].includes(r.tier) || !r.lowestCostSuitableTierVerified || !r.accountVerified || !r.versionVerified || !r.citationsVerified || !r.citationsEnabled || !request.projectId) throw new StageError("unsupported_configuration");
  } else {
    const b = request.baseline;
    if (!b || b.snapshot.call_kind !== r.stage || b.snapshot.provider_id !== r.providerId || b.snapshot.model !== r.requestedModel || !Number.isFinite(b.snapshot.params.temperature) || !Number.isInteger(b.snapshot.params.max_tokens) || b.snapshot.params.max_tokens <= 0) throw new StageError("baseline_snapshot_missing");
    const origins: Record<string, string> = { "xai-grok": "https://api.x.ai", openai: "https://api.openai.com", openrouter: "https://openrouter.ai", "anthropic-claude": "https://api.anthropic.com", "google-gemini": "https://generativelanguage.googleapis.com" };
    // Avoid accepting a credential-bearing arbitrary URL. No fallback is selected here.
    if (!origins[b.snapshot.provider_id] || new URL(b.baseUrl).origin !== origins[b.snapshot.provider_id] || new URL(b.baseUrl).username || new URL(b.baseUrl).password || new URL(b.baseUrl).search) throw new StageError("unsupported_provider_endpoint");
  }
  const s = request.resume;
  if (s && s.contextHash !== contextHash(request)) throw new StageError("resume_mismatch");
  if (s && (s.runId !== request.runId || s.sourceHash !== request.pack.sourceHash || s.settingsHash !== r.settingsHash || s.stage !== r.stage || s.configuration !== r.configuration)) throw new StageError("resume_mismatch");
  if (s?.submissionUncertain && !s.jobId) throw new StageError("submission_uncertain");
  // Baseline failures/revisions cannot be replayed invisibly. Batch starts separately labelled attempts.
  if (r.configuration === "baseline" && s?.attempts.length) throw new StageError("baseline_resume_unsupported");
}
/** Read provider-reported token counts from payload; returns null when absent. */
function tokenUsage(payload: Record<string, unknown>): LlmUsage | null {
  const u = record(payload.usage), g = record(payload.usageMetadata);
  if (Object.keys(g).length) {
    const reasoning = count(g.thoughtsTokenCount), visible = count(g.candidatesTokenCount);
    return { input_tokens: count(g.promptTokenCount), output_tokens: visible === null ? null : visible + (reasoning ?? 0), total_tokens: count(g.totalTokenCount), reasoning_tokens: reasoning };
  }
  if (!Object.keys(u).length) return null;
  const input = "input_tokens" in u ? count(u.input_tokens) : count(u.prompt_tokens);
  const cached = (count(u.cache_creation_input_tokens) ?? 0) + (count(u.cache_read_input_tokens) ?? 0);
  return { input_tokens: input === null ? null : input + cached, output_tokens: count(u.output_tokens ?? u.completion_tokens), total_tokens: count(u.total_tokens), reasoning_tokens: count(record(u.completion_tokens_details).reasoning_tokens) };
}
/** Convert complete finite usage credits to USD; returns null for unknown billing. */
function extractCost(usage: unknown): number | null {
  const u = record(usage), credits = count(u.credits);
  // credits can include only recorded components; missing component billing stays unknown.
  return credits !== null && count(u.extract_credits) !== null && count(u.parse_credits) !== null ? credits * EXTRACT_USD_PER_CREDIT_2026_10_13 : null;
}
/** Validate stage data and map citation metadata against request blocks; throws StageError for invalid schema. */
function normalize(data: unknown, metadata: unknown, request: ExtractRequest): ExtractFinding[] {
  const stage = request.route.stage as keyof typeof schemas;
  const parsed = schemas[stage].safeParse(data);
  if (!parsed.success) throw new StageError("invalid_output_schema");
  const key = stage === "need_extract" ? "gaps" : "tactics";
  const candidates = list(record(parsed.data)[key]);
  const fieldMetadata = list(record(record(record(metadata).field_metadata).document_metadata)[key]);
  return candidates.map((candidate, index) => {
    const item = record(candidate), meta = record(fieldMetadata[index]);
    const citations = stage === "need_extract" ? list(record(meta.statement).citation) : [...list(record(meta.name).citation), ...list(record(meta.evidence_question).citation)];
    const spans = list(item.provenance) as ProvenanceSpan[];
    const evidence = request.route.configuration === "extract" ? citations.map((c) => ({ quote: string(record(c).matching_text) ?? "", block_id: null, source_file_id: request.pack.packId })) : spans;
    const reasons: string[] = [], provenance: ProvenanceSpan[] = [], locations: ParsedBlock["location"][] = [];
    if (!evidence.length) reasons.push("missing_citations");
    for (const span of evidence) {
      if ([item.external_id, span.block_id, request.pack.packId].filter(Boolean).includes(span.quote.trim())) { reasons.push("identifier_only"); continue; }
      const matches = request.pack.source.blocks.filter((b) => validateQuoteAgainstBlock({ block: b, quote: span.quote }).ok);
      if (matches.length !== 1) { reasons.push(matches.length > 1 ? "ambiguous_quote" : "quote_mismatch"); continue; }
      const block = matches[0];
      if (span.source_file_id !== request.pack.packId || (request.route.configuration === "baseline" ? span.block_id !== block.id : span.block_id && span.block_id !== block.id)) { reasons.push("attribution_mismatch"); continue; }
      provenance.push({ source_file_id: request.pack.packId, block_id: block.id, quote: span.quote }); locations.push(block.location);
    }
    // Extract metadata cannot rescue explicitly false raw provenance.
    if (request.route.configuration === "extract") for (const span of spans) {
      const b = request.pack.source.blocks.find((b) => b.id === span.block_id);
      if (span.source_file_id !== request.pack.packId || !b || !validateQuoteAgainstBlock({ block: b, quote: span.quote }).ok) reasons.push("raw_provenance_mismatch");
    }
    return { id: `${request.runId}:${key}:${index}`, statement: String(item.statement ?? item.evidence_question), external_id: string(item.external_id), details: item, provenance, citation: { valid: reasons.length === 0, reasons: [...new Set(reasons)], locations, metadata: fieldMetadata[index] ?? null } };
  });
}
/** Check raw stage draft using existing stage-specific checklist; returns revision issues before strict schema validation. */
function critique(data: unknown, request: ExtractRequest): string[] {
  const key = request.route.stage === "need_extract" ? "gaps" : "tactics", items = list(record(data)[key]);
  const issues: string[] = [], seen = new Set<string>();
  if (!items.length) issues.push(key === "gaps" ? "no_gaps_proposed" : "no_tactics_proposed");
  for (const [index, value] of items.entries()) {
    const item = record(value), inventory = key === "tactics";
    const subject = inventory ? string(item.name)?.trim() || `tactic_${index}` : string(item.external_id) || string(item.statement)?.slice(0, 40) || `gap_${index}`;
    if (inventory && item.origin && item.origin !== "inventory") issues.push(`${subject}:wrong_origin`);
    if (!string(item.statement ?? item.name)?.trim()) issues.push(`${subject}:missing_${key === "gaps" ? "statement" : "name"}`);
    const spans = list(item.provenance);
    if (!spans.length) issues.push(`${subject}:no_quote`);
    for (const value of spans) { const s = record(value); if (s.source_file_id !== request.pack.packId) issues.push(`${subject}:source_file_mismatch`); if (!string(s.quote)?.trim()) issues.push(`${subject}:empty_quote`); }
    const identity = String(inventory ? item.name ?? "" : item.external_id || item.statement || "").trim().toLowerCase();
    if (identity) { if (seen.has(identity)) issues.push(`${subject}:duplicate`); seen.add(identity); }
  }
  return issues;
}

/** Run one baseline proposal (and checklist revision), or one Extract submission/poll.
 * @param request Complete source, frozen route and optional opaque resume checkpoint; no gold is read.
 * @param transport Single-attempt fetch, credential and caller approval/persistence callbacks.
 * @returns Findings and ledger, or pending/blocked/failed status with a structured error.
 * Transport, schema and checkpoint failures are captured; no automatic retry occurs.
 */
export async function extractStage(request: ExtractRequest, transport: ExtractTransport): Promise<ExtractResult> {
  const start = Date.now();
  const state: ExtractState = structuredClone(request.resume ?? { runId: request.runId, sourceHash: request.pack.sourceHash, settingsHash: request.route.settingsHash, contextHash: contextHash(request), stage: request.route.stage, configuration: request.route.configuration, uploadId: null, jobId: null, submissionUncertain: false, rawOutputs: [], attempts: [] });
  const result: ExtractResult = { status: "blocked", runId: request.runId, attemptId: request.attemptId, state, findings: [], rawOutputs: state.rawOutputs, attempts: state.attempts, actualRoute: { providerId: null, model: null, version: null, tier: null, label: "unverified" }, usage: null, costUsd: null, elapsedMs: 0 };
  const secrets = [transport.apiKey, ...Object.values(request.baseline?.headers ?? {})];
  /** Persist a detached current state; callback failures stop extraction. */
  async function checkpoint() { await transport.checkpoint(structuredClone(state)); }
  /** Approve and record one HTTP operation; return parsed payload or throw a classified failure. */
  async function http(operation: ExtractAttempt["operation"], url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const attempt: ExtractAttempt = { id: `${request.attemptId}:${state.attempts.length + 1}`, operation, startedAt: new Date().toISOString(), elapsedMs: 0, httpStatus: null, status: "started", costUsd: null, usage: null };
    try { await transport.beforeAttempt(structuredClone(attempt), structuredClone(state)); } catch { throw new StageError("budget_blocked"); }
    state.attempts.push(attempt);
    if (operation === "submit") state.submissionUncertain = true;
    await checkpoint();
    const began = Date.now();
    try {
      const response = await transport.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(60_000) });
      attempt.httpStatus = response.status;
      const body = await response.text();
      let payload: unknown, malformed = false;
      try { payload = JSON.parse(body); } catch { payload = { unparsedBody: body }; malformed = true; }
      const clean = sanitize(payload, secrets);
      state.rawOutputs.push(clean);
      const p = record(clean);
      attempt.usage = operation === "baseline" ? tokenUsage(p) : p.usage ?? null;
      result.usage = attempt.usage;
      if (operation !== "baseline") result.costUsd = extractCost(p.usage);
      if (!response.ok) throw new StageError("http_error", [408, 429, 500, 502, 503, 504].includes(response.status), response.status);
      if (malformed) throw new StageError("invalid_json");
      attempt.status = "completed";
      if (operation === "upload") state.uploadId = string(p.id);
      if (operation === "submit") { state.jobId = string(p.id); state.submissionUncertain = !state.jobId; }
      await checkpoint();
      return p;
    } catch (error) {
      attempt.status = "failed";
      const e = error instanceof StageError ? error : new StageError("transport_error", true);
      attempt.error = { code: e.code, temporary: e.temporary, httpStatus: e.httpStatus };
      throw e;
    } finally { attempt.elapsedMs = Date.now() - began; await checkpoint(); }
  }
  try {
    validateRequest(request);
    if (!transport.apiKey) throw new StageError("credential_missing");
    const text = sourceText(request), system = request.route.stage === "need_extract" ? NEED_PROPOSER_SYSTEM : INVENTORY_PROPOSER_SYSTEM;
    if (request.route.configuration === "extract") {
      const base = "https://api.cloud.llamaindex.ai", auth = { authorization: `Bearer ${transport.apiKey}` };
      if (!state.uploadId) {
        const form = new FormData(); form.append("file", new Blob([text], { type: "text/plain" }), "source.txt"); form.append("purpose", "extract");
        await http("upload", `${base}/api/v1/beta/files`, { method: "POST", headers: auth, body: form });
        if (!state.uploadId) throw new StageError("missing_upload_id");
      }
      let payload: Record<string, unknown>;
      if (!state.jobId) {
        payload = await http("submit", `${base}/api/v2/extract?project_id=${encodeURIComponent(request.projectId!)}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ file_input: state.uploadId, configuration: { version: "2.5", tier: request.route.tier, extraction_target: "per_doc", cite_sources: true, confidence_scores: false, system_prompt: system, data_schema: z.toJSONSchema(schemas[request.route.stage as keyof typeof schemas]) } }) });
        if (!state.jobId) throw new StageError("missing_job_id");
      } else {
        payload = await http("poll", `${base}/api/v2/extract/${encodeURIComponent(state.jobId)}?project_id=${encodeURIComponent(request.projectId!)}&expand=extract_metadata&expand=configuration&expand=usage`, { method: "GET", headers: auth });
      }
      if (string(payload.id) !== state.jobId || (payload.file_input && payload.file_input !== state.uploadId)) throw new StageError("job_identity_mismatch");
      const config = record(payload.configuration);
      result.actualRoute = { providerId: "llamaextract", model: string(payload.model), version: string(config.version), tier: string(config.tier), label: "unverified" };
      if (result.actualRoute.version && (result.actualRoute.version !== "2.5" || result.actualRoute.tier !== request.route.tier || config.cite_sources !== true)) result.actualRoute.label = "substituted";
      else if (result.actualRoute.version === "2.5" && result.actualRoute.tier === request.route.tier && config.cite_sources === true) result.actualRoute.label = "verified";
      result.usage = payload.usage ?? null;
      result.costUsd = extractCost(payload.usage);
      const latest = state.attempts.at(-1); if (latest) latest.actualRoute = { ...result.actualRoute };
      if (payload.status === "FAILED" || payload.status === "CANCELLED") throw new StageError("job_failed");
      if (payload.status === "PENDING" || payload.status === "RUNNING") result.status = "pending";
      else if (payload.status === "COMPLETED") { result.findings = normalize(payload.extract_result, payload.extract_metadata, request); result.status = "completed"; }
      else throw new StageError("unknown_job_status");
    } else {
      const baseline = request.baseline!, snapshot = baseline.snapshot, provider = snapshot.provider_id;
      /** Send source plus checklist issues; return raw draft or throw on provider/JSON failure. */
      async function complete(critiques: string[]) {
        const user = [`workspace_id=benchmark:${request.runId}`, text, critiques.length ? `Critic issues to fix:\n${critiques.map((c) => `- ${c}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
        let url = `${baseline.baseUrl.replace(/\/$/, "")}/chat/completions`;
        let headers: Record<string, string> = { ...baseline.headers, "content-type": "application/json", authorization: `Bearer ${transport.apiKey}` };
        let body: unknown = { model: snapshot.model, ...snapshot.params, ...(provider === "openrouter" ? { response_format: { type: "json_object" } } : {}), messages: [{ role: "system", content: system }, { role: "user", content: user }] };
        if (provider === "openrouter") {
          headers = { "http-referer": "https://github.com/Shashb21/synapse", "x-title": "Synapse IEGP", ...headers };
        }
        if (provider === "anthropic-claude") {
          url = `${baseline.baseUrl.replace(/\/$/, "")}/v1/messages`; headers = { ...baseline.headers, "content-type": "application/json", "x-api-key": transport.apiKey, "anthropic-version": "2023-06-01" };
          body = { model: snapshot.model, max_tokens: snapshot.params.max_tokens, ...anthropicSampling(snapshot.model, snapshot.params.temperature), system, messages: [{ role: "user", content: user }] };
        } else if (provider === "google-gemini") {
          url = `${baseline.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(snapshot.model)}:generateContent`; headers = { ...baseline.headers, "content-type": "application/json", "x-goog-api-key": transport.apiKey };
          body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: snapshot.params.temperature, maxOutputTokens: snapshot.params.max_tokens, responseMimeType: "application/json" } };
        }
        const payload = await http("baseline", url, { method: "POST", headers, body: JSON.stringify(body) });
        const model = string(payload.model ?? payload.modelVersion);
        result.actualRoute = { providerId: provider, model, version: null, tier: string(payload.service_tier), label: model === null ? "unverified" : model === snapshot.model && !snapshot.degraded ? "verified" : "substituted" };
        state.attempts.at(-1)!.actualRoute = { ...result.actualRoute };
        const usage = tokenUsage(payload); result.usage = usage;
        state.attempts.at(-1)!.usage = usage;
        const choice = record(list(payload.choices)[0]), candidate = record(list(payload.candidates)[0]);
        if (payload.error || choice.finish_reason === "length" || candidate.finishReason === "MAX_TOKENS" || record(payload.promptFeedback).blockReason || (provider === "anthropic-claude" && anthropicAnswer(payload) === null)) throw new StageError("provider_output_error");
        const raw = provider === "anthropic-claude" ? anthropicAnswer(payload) : provider === "google-gemini" ? list(record(candidate.content).parts).map((p) => string(record(p).text) ?? "").join("\n") : string(record(choice.message).content);
        if (!raw) throw new StageError("missing_output");
        try { return JSON.parse(raw) as unknown; } catch { throw new StageError("invalid_output_json"); }
      }
      let draft = await complete([]);
      const issues = critique(draft, request);
      if (baseline.shallowCycle && issues.length) {
        const revision = await complete(issues), key = request.route.stage === "need_extract" ? "gaps" : "tactics";
        if (list(record(revision)[key]).length) draft = revision;
      }
      result.findings = normalize(draft, null, request); result.status = "completed";
      if (state.attempts.some((a) => a.actualRoute?.label === "substituted")) result.actualRoute.label = "substituted";
      else if (state.attempts.some((a) => a.actualRoute?.label === "unverified")) result.actualRoute.label = "unverified";
    }
    await checkpoint();
  } catch (error) {
    const e = error instanceof StageError ? error : new StageError("internal_error");
    result.status = state.attempts.length ? "failed" : "blocked";
    result.error = { code: e.code, temporary: e.temporary, httpStatus: e.httpStatus };
  }
  result.elapsedMs = Date.now() - start;
  return result;
}
