# KAN-202 real-stage computation contract

Task 1 provides computation only. Task 2 owns authentication, immutable execution manifests, exact current prerequisite selection, persistence, role routing, AI switch checks before every provider send, dispatch claims, saved replies, costs and durable delivery. The adapter never selects a provider or calls one directly.

## Configuration exports

`src/modules/development/execution-schema.ts` exports:

```ts
type ExecutionMode = 'standard' | 'single_pass';
type ExecutionRoute = {
  provider_id: string;
  model: string;
  temperature: number;
  max_tokens: number;
  fallbacks: string[];
};
type ExecutionConfig = {
  mode: ExecutionMode;
  stages: Record<DevelopmentSection, {
    route: ExecutionRoute;
    overrides: Partial<Record<CompletionRole, ExecutionRoute>>;
  }>;
  evaluator: ExecutionRoute;
};
```

`executionConfigSchema`, `stageExecutionConfigSchema`, `executionRouteSchema`, `executionModeSchema`, `EXECUTION_ROLES`, `SECTION_STAGES` and `SECTION_DEPENDENCIES` are public. Schemas reject unknown keys. Standard is the default. Defaults use the existing xAI provider/model and Anthropic/OpenAI fallback list, temperature 0.2 and 16,000 output tokens. Temperature is bounded to 0–2 and output tokens to 256–64,000. Primary models must belong to the selected registered API-key provider; fallback IDs must name distinct registered API-key providers and exclude the primary. Actual credentials, dispatch-time availability and provider-specific request settings remain Task 2 responsibilities.

Single pass rejects critic/reviser/internal_judge overrides rather than silently retaining disabled settings. Initial structural repair may make additional proposer calls; Single pass means one proposal phase, not a guaranteed single billed request. Evaluator configuration is stored separately and is never consumed by generation.

The dependency table is:

| Section | Real stage | Exact direct dependencies |
| --- | --- | --- |
| gap_extraction | S2 | none |
| tactic_extraction | S3 | none |
| matching_coverage | S4 | gap_extraction, tactic_extraction |
| partial_splitting | S6 | matching_coverage |

## Adapter exports

`src/modules/development/stage-execution.ts` exports:

```ts
type SectionModuleIdentity = { id: string; version: string };
type SectionPromptIdentity = { id: string; instruction: string };

type ExecuteDevelopmentSectionInput = {
  section: DevelopmentSection;
  sources: readonly DevelopmentDocument[];
  prerequisites: Partial<Record<DevelopmentSection, DevelopmentSectionResult>>;
  mode?: ExecutionMode;                  // default standard
  recorder: RunHandle;                   // stable ID across continuation replay
  complete: JsonCompletion;              // injected role-aware boundary
  route?: ResolvedRoute;                 // connected compute route metadata
  module_identity?: SectionModuleIdentity;
  prompt_identity?: SectionPromptIdentity;
};

executeDevelopmentSection(args: ExecuteDevelopmentSectionInput): Promise<DevelopmentSectionResult>;
developmentModuleIdentity(section: DevelopmentSection): SectionModuleIdentity;
developmentOutputIdentity(result: Omit<DevelopmentSectionResult, 'output_id'> | DevelopmentSectionResult): string;
```

`DevelopmentSectionResult` contains:

```ts
{
  section: DevelopmentSection;
  mode: ExecutionMode;
  generation_status: 'succeeded' | 'rejected' | 'not_applicable';
  review_status: 'unreviewed';
  reason: string | null;
  output: unknown;                       // real stage output; S6 aggregates per gap
  candidates: Record<string, unknown>[]; // checked usable proposals, not human approvals
  raw_result: ModuleResult<unknown>;
  model_outputs: { request: Parameters<JsonCompletion>[0]; response: unknown }[];
  local_state: IegpState;
  source_identity: string;
  prerequisite_ids: Partial<Record<DevelopmentSection, string>>;
  output_id: string;
  trace_id: string;
  module_identity: SectionModuleIdentity;
  prompt_identity: SectionPromptIdentity;
  omitted_roles: string[];
}
```

`output_id` hashes the complete JSON-normalized result excluding itself. Exact prerequisite output hashes, source identities and success states are verified before computation. The caller must bind the latest intended prerequisite IDs; the adapter cannot query whether a newer section attempt exists. It rejects extra/missing direct prerequisites, reference-role documents, changed parsed hashes, duplicate source/block IDs and changed frozen module identity. Source identity binds ordered source IDs, raw/parsed hashes, filename, parser identity and parse timestamp.

S2/S3 start from a blank experiment-local domain context containing source snapshots only. They never load customer gaps, tactics, objectives, reviewer examples or reference answers. Parsed blocks retain snapshot provenance. Candidate citations must quote their own supplied document. Result gaps and tactics remain candidates, with no human validation. Missing scientific fields remain empty and confidence is null where the domain type permits unknown values. Required technical actor/stakeholder defaults use evidence_lead; they do not assert a source author's identity.

S4 consumes exact local S2/S3 outputs using the real mapping parser, complete coverage dimensions and supplied-record citation inspection. All full/partial/limited/not_relevant categories remain in the actual output and local coverage state. The exported stage-owned `developmentMappingCoverages(state, rows, runId)` builds typed local coverages, retaining AI origin, unlocked assessments and `human_adopted: false`. Candidate-only eligibility is gated by both `execution_scope: 'development'` and evaluation replay, leaving production eligibility unchanged.

S6 consumes real S4 partial rows and counting tactic lifecycle rules. No eligible partial gap returns not_applicable without a completion. Its frozen mapped-scope facts omit not_relevant/unassessed assessments, matching real S4 assignment behavior; those original categories remain inspectable in the result. S6 uses the real proposal parser, allowed tactic IDs, parent scope and dimensions. It never supplies `apply`, creates child gaps, or calls split application. Multiple eligible gaps are executed in stable row order; `raw_result.output.stage_results` preserves every original per-gap module result, including rejection.

## Role and replay boundary

`JsonCompletion` now accepts optional `role?: 'proposer' | 'critic' | 'reviser' | 'internal_judge'`. Production callers remain compatible. Every model call in these four stages supplies the originating role explicitly, including validation repairs. Task 2 must select `overrides[request.role] ?? stage.route`, freeze requested/resolved routing and explicit fallback, and persist each raw provider response before returning it through this completion boundary.

`ModuleContext` adds optional `execution_policy?: 'standard' | 'single_pass'` and `execution_scope?: 'development'`. Production defaults preserve the existing three critic exchanges and model judge. Single pass returns the initial structurally checked proposals, omits critic/revision/internal acceptance and does not invent judge scores. S3's separate post-cycle model judge is also bypassed. Standard model rejection is preserved rather than converted to fallback success. All results retain review_status unreviewed regardless of internal model judgement.

`ModuleResult.agentic` optionally retains `proposed`, `unreviewed`, `judged` and `withdrawn` arrays. This is supplementary experiment data; existing production output schemas remain unchanged.

The completion boundary intentionally catches no errors. A Task 2 continuation sentinel or provider failure propagates unchanged. To resume, rerun the adapter with the same frozen sources, prerequisite objects, mode, module/prompt identities, recorder ID and replies. Persist/compare a canonical hash of every next completion request before dispatch. Return cloned saved JSON for already completed calls. A mismatch must stop safely; never automatically resend a request whose provider acceptance is uncertain. Adapter `model_outputs` is available only on successful return, so durable per-call recording must live outside the adapter.

The adapter does not read or mutate customer state, create customer candidate rows, use customer runStage, evaluate references or send provider HTTP requests. Those isolation properties are enforced by replay evaluation and tested with customer-store and database calls forbidden.

## Owner HTTP execution API

All three owner endpoints apply the existing owner authorization before reading private data and return `Cache-Control: no-store`. Requests use the ordinary owner session; the scheduler bearer secret does not grant owner access.

`POST /api/admin/development/{id}/executions` accepts this bounded strict JSON object:

```json
{
  "revision": 2,
  "target": "all",
  "config": { "mode": "single_pass" },
  "prerequisites": {}
}
```

`target` is `all` or one section identifier from the dependency table. Configuration can omit default fields; returned manifests contain the fully parsed configuration. Run All creates fresh S2, S3, S4 and S6 attempts; it never reuses an older output. Individual S2/S3 requests use empty prerequisites. Individual S4 requests supply the exact latest successful S2 and S3 identities. Individual S6 requests supply S2, S3 and S4, including the exact upstream identities that S4 consumed:

```json
{
  "revision": 2,
  "target": "partial_splitting",
  "config": { "mode": "single_pass" },
  "prerequisites": {
    "gap_extraction": { "attempt_id": "section-attempt-id", "output_id": "64-character-sha256" },
    "tactic_extraction": { "attempt_id": "section-attempt-id", "output_id": "64-character-sha256" },
    "matching_coverage": { "attempt_id": "section-attempt-id", "output_id": "64-character-sha256" }
  }
}
```

The illustrative output IDs above must be replaced with the actual 64 lowercase hexadecimal characters from the selected results. A newer failed/rejected upstream attempt invalidates an older success. Source snapshots, execution mode, that upstream section's generation configuration, module/prompt identity or deployment code changes also invalidate its reuse. Evaluator-only changes do not. A stale draft revision or prerequisite produces 409. Invalid schema/provider/model/settings produce 400. Missing/changed/incompatible source snapshots produce 422. Missing durable delivery produces 503. The UI should display the returned safe `error` and reload history after 409.

Success returns HTTP 202 with `{ execution: Execution }`. It means the immutable manifest and section attempts were committed; provider work runs through the independent worker. A database unique index forbids two queued/running executions for one experiment. Disabling the action while a request is pending improves usability, but the server/database also enforce conflicts.

`GET /api/admin/development/{id}/executions` returns `{ executions: Execution[], delivery: { available, transport, reason } }`, newest first, limited to 50 executions. All database attempts are retained; older known IDs remain available through detail. `GET /api/admin/development/{id}/executions/{executionId}` returns `{ execution: Execution }` or 404 for an absent/foreign execution.

The public TypeScript response contracts are exported by `execution-store.ts`. `Execution` contains `id`, `experiment_id`, frozen `manifest`, `generation_status`, independent `evaluation_status`, timestamps, safe `error`, ordered `sections` and raw `calls`. It excludes worker claim tokens/leases. The manifest freezes source documents only (never reference/gold), requested configuration, per-role requested/actual routes, actual temperature behavior, module/prompt/code identities, exact prerequisite outputs and retry policy. Section attempts preserve their own IDs, status, output/result, errors and exact dependency attempt IDs. Call rows preserve ordinal/request hash, explicit role/purpose/repair attempt, raw request, frozen actual route, queued/sending/settled timestamps, raw response, usage/cost/provenance and sanitized errors. These are private owner diagnostics; do not render raw request/response text as HTML.

Generation states are `queued`, `running`, `succeeded`, `failed`, `needs_attention`. Section states add `rejected`, `blocked`, `not_applicable`. Every generated result remains `review_status: unreviewed`. Partial independent successes remain inspectable after another section fails. S3 continues when S2 fails; S4 and S6 block if their prerequisite failed/rejected. With no eligible partial gaps S6 is `not_applicable`, without provider calls. UI progress can count terminal section states and show per-call activity. Polling is optional for display and does not drive the worker.

Evaluation is deliberately `not_requested` in this ticket. No evaluator request runs and no evaluator result is fabricated. A later evaluation service owns its independent lifecycle. Keep generation and evaluation labels separate; a generation result never implies reference evaluation or human approval.

## Durable dispatch and accounting

Each `progressExecution(id?)` invocation claims one queued/recoverable execution and makes at most one actual provider send. Database compare-and-set updates (updates conditional on the current claim and state) persist `sending` before provider I/O and settle the authoritative raw receipt before any computation can consume it. Saved raw replies pass through the real JSON parser/repair algorithm; each repair is a distinct durable call. Repeated or simultaneous deliveries replay receipts and cannot send the same call twice. A canonical request identity mismatch stops the attempt.

Every actual send, including repair calls, rechecks the AI master switch, applicable section switch and worker lease. The dispatch uses only the frozen provider/model/settings, never current shared routing. An unavailable frozen provider fails without opportunistic fallback. Explicit allowed fallback is resolved at execution creation and retained with both requested and actual identity. Shared/customer routes are never changed.

The Development worker passes `maxAttempts: 1` through `tracedCompletion` to each provider HTTP helper. Even explicit 429/503 failures terminate that section attempt; there is no automatic transport retry here. Ordinary provider callers retain their existing four-attempt policy. Interrupted `sending` calls or a failed authoritative receipt write become `needs_attention` and are never automatically resent. Failed/uncertain attempts can only be replaced by an explicit fresh user attempt, which may incur another charge. Pre-dispatch queued calls can resume safely after lease expiry. The five-minute lease exceeds the bounded three-minute HTTP worker invocation.

Existing `tracedCompletion` accounting runs with the experiment section-attempt ID and `workspace_id: null`, so experiment usage does not enter customer workspace totals. Durable receipts are authoritative; supplementary `llm_calls` records remain best effort. Successful missing usage can be estimated by existing policy; provider-reported usage on invalid/cut-off responses is retained. Unknown price stays `null`, never zero. Current pricing is an existing manual estimate and global accounting does not implement an allowance gate. KAN-206 owns experiment estimate/allowance controls.

Deployment requirements and verification are in [execution-deployment.md](./execution-deployment.md).

## Owner history redaction and worker leases

`getExecution` is an internal replay read and retains raw call requests and receipts. Owner HTTP creation, list and detail responses use `getOwnerExecution` or `listOwnerExecutions`, which recursively copy and redact configured provider keys and recognized credential-shaped strings. The owner gate and experiment association are checked before these reads. Replay data is not modified: changing a saved provider reply would change the computation on continuation. Redaction recognizes current configured keys and common key formats; it cannot identify every arbitrary secret or a retired key with an unrecognized format. Treat the underlying database and its backups as sensitive.

A worker may checkpoint, settle, publish or release work only while its claim is current. Expired workers cannot release an execution even if no replacement worker has claimed it yet. Interrupted sends remain uncertain and are not automatically resent.

## KAN-203 history metadata

List responses add `next_cursor` (an execution ID or null). Pass it as `?cursor=...` to read the next page; ordering uses creation time and ID to break ties. Detail and list responses also add `history`, keyed by section attempt ID. Each entry contains `freshness: { current, reasons }` and independent `evaluations`. Reasons are `newer_attempt`, `generation_inputs_changed`, or `prerequisite_changed`. The server compares the current draft's source documents, current code/module/prompt identities and the latest retained attempts, including transitive dependency bindings. Supply `?config=<URL-encoded JSON>` to compare against current controls; it is bounded and parsed by `executionConfigSchema`. Without it, each execution's frozen configuration is used. A failed newest attempt remains newest and cannot restore an earlier success. Historical results are never rewritten.

Manifests created after this change include `references` with document IDs, section, content hashes and source associations; reference contents never enter generation. Existing manifests can omit it. Section attempts include nullable `started_at` and `finished_at`; call `sending_at` and `settled_at` allow latency calculation. Existing rows may have null timing. Owner reads redact recursively, while the worker's internal replay read remains raw.

`execution-store.ts` exports `EvaluationIdentity`, `EvaluationAssociation`, `EvaluationStatus`, `createEvaluationAssociation`, `listEvaluationAssociations`, and `evaluationFreshness`. Creation verifies that the exact attempt and output belong to the experiment and starts `unscored`; no evaluator runs. `evaluationBindings(config, documents, referenceIds)` from `execution.ts` supplies the evaluator hash and a hash of only the selected references; missing selected references also change the hash. `transitionEvaluationAssociation` advances permitted lifecycle states with an expected-state check, scoped to the experiment. Per-attempt evaluation entries report their own state, freshness and `evaluator_changed`, `references_changed` or `attempt_changed` reasons. Profile IDs are retained, but automatic comparison to a current profile is unavailable until a profile service supplies that identity. There is no scoring orchestration or public status-update endpoint here; the typed store transition helper is available to a future evaluation service. The `evaluationFreshness` helper accepts caller-supplied current identities, including the profile ID.

Credential-bearing provider replies are rejected before the authoritative receipt is stored; usage and cost remain in failure accounting. The reply is not changed and replayed, which would change the computation. The supplementary LLM log applies its existing redaction. The detector can miss unknown secret formats and can reject benign text resembling a secret. Raw requests and source snapshots are retained for deterministic replay and can contain sensitive material; database access and backups must remain restricted. Historical raw receipts from before this change cannot be retroactively sanitized without breaking replay.
