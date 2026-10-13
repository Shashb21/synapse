# KAN-94: optional OpenRouter gateway design

Design date: **2026-10-11**. Code baseline: **`d92ebc3b0ce99c1a00ee39b1b4f45927ebb8ba9f`** (refreshed `github/main`). This document proposes implementation controls; it does not enable a gateway, approve processing, change product code, or submit customer data. KAN-93 has no approved decision. All GO statuses below are conditional approval outcomes, not current authorizations.

A gateway receives Synapse's request and chooses an inference provider (the organization actually running the model). `routing_mode = direct | openrouter` chooses the processing path; `model_profile = budget | balanced | quality_focused` chooses a reviewed model mapping. These are independent settings. A simple example is `openrouter + balanced`: it still requires a specific model ID, a permitted inference provider and a workspace approval; a label alone cannot authorize a call.

## 1. Current behavior and precise gaps

All code citations below use the baseline SHA above. Line ranges are inspection evidence, not claims about later versions.

| Area | Existing implementation | Proposed change / gap |
| --- | --- | --- |
| KAN-65 credentials | `src/modules/llm/api-keys.ts:3–28,56–82` maps `openrouter` to `OPENROUTER_API_KEY`, reads it server-side, and exposes presence only. There is no provider login. | Keep this mechanism. A configured key proves connectivity, not permission to process a workspace's data. Never put values in logs, UI, exports or policy configuration. |
| Existing OpenRouter adapter | `src/modules/llm/provider.ts:447–475` uses `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), bearer auth, application attribution headers, `OPENROUTER_MODELS` and default `x-ai/grok-4`. `chatCompletions` appends `/chat/completions` and sends system/user messages, temperature, max tokens and `response_format: {type: "json_object"}` (`:223–250`). | Reuse the adapter. The current configured list is not a live catalog check; it has no exact provider/region allowlist, approval or retention control. Restrict base URL to a reviewed endpoint; an environment override must not silently create a new processing boundary. |
| JSON contract | Providers return text; parsing belongs to callers (`provider.ts:45–60`). Customer `completionFor` extracts a JSON object and allows three malformed-JSON re-asks (`src/modules/kernel/routing.ts:265–315`). Accuracy returns `{raw, usage}` and `completeJson` parses it (`src/accuracy/kernel/routing.ts:189–237,255–262`). The gateway JSON-object hint is not a business-schema guarantee. | Preserve both contracts; validate the module's schema and completeness locally. Add strict gateway JSON-schema mode only for a catalog-verified model/endpoint supporting it. Never return invalid output as a successful decision. |
| Customer resolution/fallback | Per-stage configuration; missing/unknown providers are skipped; first configured API-key provider wins; fallback uses that adapter's default model (`src/modules/kernel/routing.ts:195–228`). Defaults are Grok, then Claude and OpenAI (`provider.ts:478–484`). | This is resolution-time fallback, not retry after a failed dispatched call. Apply policy before candidate selection. Gateway mode must not inherit a direct-provider fallback chain. |
| Stale saved models | Customer route reads use `servedModel`, replacing an unlisted saved model with adapter default (`routing.ts:108–126`; `provider.ts:490–502`). Accuracy reads also normalize the model (`src/accuracy/kernel/routing.ts:82–83`). Customer writes validate models (`routing.ts:154–177`). Accuracy writes accept a model string, and an empty fallback array restores defaults (`src/accuracy/kernel/routing.ts:100–133`); its API treats empty input as keep-current (`src/app/api/accuracy/routing/route.ts:54–68`). | New gateway/profile routes reject stale/unknown IDs, require explicit migration approval, and preserve an empty fallback list. Make both setters enforce the same reviewed contract. |
| Accuracy roles | Per `call_kind` / `agent_role` configurations and resolver exist; roles are `proposer`, `critic`, `reviser`, `judge`; non-LLM kinds have empty roles (`src/accuracy/kernel/contracts.ts:5–45`; `routing.ts:136–187,290–297`). | Reuse this topology and existing stage routes. Do not add model calls to mechanical/human stages. Resolve profiles into these existing slots. |
| Authenticated configuration | Customer platform route writes are owner-only (`src/app/api/control/route.ts:37–45,105–118,151–167`). Accuracy writes are owner-gated and check `configure_routing` (`src/app/api/accuracy/routing/route.ts:100–148`). Both record configuration audits. | Keep authenticated server authority. Workspace data approval is a separate permission; an owner clicking a profile is insufficient. Scope platform configuration plus workspace approval without allowing a request body to supply its own approval. |
| KAN-91 records | Both completion wrappers use `tracedCompletion`. It stores full prompts/replies with secret redaction, usage, estimated cost, latency and failures in `llm_calls`, linked to run steps (`src/modules/kernel/llm-calls.ts:20–57,74–106,174–245`). Storage failure produces an `llm_call:unrecorded` note and preserves a received reply. | Extend the existing owner-managed record rather than create a competing trace store. Current adapter-level records do not identify hidden HTTP retry attempts, actual downstream provider/region, gateway response IDs, or approval/catalog revisions. |
| Retry/timeout | `postJson` allows four attempts for non-daily rate limits, HTTP 503 and empty-body 404, with 2-second initial backoff and waits capped at 60 seconds (`provider.ts:81–130`). Each fetch uses `SYNAPSE_LLM_TIMEOUT_MS`, default 120 seconds; network/timeout throws before HTTP retry logic (`provider-error.ts:135–171`). HTTP 200 error payloads and truncation throw after usage reporting (`provider.ts:249–277`). | Bound combined HTTP retries, JSON re-asks and provider fallback under one shared deadline and attempt budget. Capture each external dispatch. Do not assume a timeout means the provider did no work. |
| Cost/retention | KAN-91 call cost can be null for unknown pricing; OpenRouter IDs map to maker pricing and lookup can use a prefix match (`src/accuracy/kernel/cost.ts:63–84,91–126`). Accuracy's alternate estimator may return zero for unknown models (`routing.ts:223–235`). Full run/call records survive workspace reset (`docs/traceability.md:27–63`). | Use exact gateway price evidence and distinguish unknown from zero throughout rollups. Synapse retention must have its own approval; external zero data retention cannot delete Synapse's stored prompts. |

## 2. Conditional availability and approval boundary

GO means the approved route may be used within its explicit scope. RESTRICTED GO means only the listed data, models, providers, purposes and regions are allowed. NO-GO means no external dispatch, even if a key is present. Mixed data takes its most restrictive classification; unknown classification is NO-GO until reviewed.

| Data class | Proposed outcome if prerequisites are met | Current prerequisite / block |
| --- | --- | --- |
| Public or synthetic | GO for isolated evaluation with reviewed routing and Synapse retention settings. Synthetic data must be checked for accidental real identifiers. | Workspace owner identifies the dataset; security/platform owner approves endpoint, catalog and budget. This document grants no evaluation authorization or paid calls. |
| Confidential, non-personal | RESTRICTED GO only for a named workspace/purpose with contractual confidentiality, no training/data use, permitted retention and provider/region controls. | KAN-93 decision plus legal/procurement and security approval; customer/workspace data owner approves the exact data scope. Otherwise NO-GO. |
| Personal data | NO-GO pending privacy review; a subsequent decision may establish RESTRICTED GO for a specific scope. | Privacy/legal confirms lawful basis, processor/subprocessor terms, transfer safeguards, residency and retention; security and data owner approve. No inference from a public documentation claim. |
| Special-category / health data | NO-GO pending explicit specialist/legal and customer approval. | Privacy/legal determines applicable special-category safeguards and, where relevant, health-data agreements and compliance requirements for every party. No claim that a gateway's privacy controls satisfy them. |

KAN-93's accountable decision owner must publish the signed disposition and evidence before any customer enablement. Legal/procurement owns contractual review; privacy owns personal/health-data review; security owns region, logging and endpoint assessment; the workspace data owner owns data classification and purpose. These are required ownership roles, not named approvals already obtained. Do not contact sales as part of KAN-94.

## 3. Configuration and data flow

Maintain server-owned, versioned policy records. An approval binds `workspace_id`, data classes, purposes, `routing_mode`, catalog revision, exact model IDs, inference-provider endpoint IDs, processing regions, retention/data-use requirements, policy revision, approving identities, evidence references, `approved_at`, `expires_at` and `revoked_at`. The effective permission is the intersection of workspace approval and platform policy. No approval, missing fields, expiry, revocation, stale revision, unknown region or unavailable policy store means NO-GO. Neither browser input nor a saved route may broaden it.

Authenticated configuration owners may select reviewed modes/profiles and explicitly ordered candidate routes. Only designated approval owners may grant scope; configuration owners cannot self-assert legal approval. Audit all changes with actor, rationale and old/new revisions. A profile change cannot alter a data approval. A direct route is also denied when that workspace permits gateway-only processing, and vice versa; switching modes requires its own approval.

Illustrative **non-runnable** configuration follows. Nulls and empty lists intentionally keep it disabled until catalog entries, provider capabilities, regions, approvals and operating budgets are verified. These names describe a proposed Synapse policy contract, not fields that already exist in OpenRouter's API.

```yaml
enabled: false
routing_mode: openrouter       # independently: direct | openrouter
model_profile: balanced        # budget | balanced | quality_focused
workspace_id: SYNTHETIC_REVIEW_WORKSPACE
policy_revision: null
approval:
  decision: NO-GO
  approval_revision: null
  evidence_refs: []
  approved_by: []
  expires_at: null
  revoked_at: null
  allowed_data_classes: []
  allowed_purposes: []
  allowed_modes: []
catalog:
  revision: null
  verified_at: null
  expires_at: null
profiles:
  balanced:
    inventory_extract:
      proposer: { gateway_model_id: null, inference_endpoint_ids: [] }
allowed_regions: []
external_policy:
  training_or_data_use_allowed: false
  require_zdr: true
  retention_evidence_ref: null
synapse_trace_policy:
  retention_days: null
  prompt_content_allowed: false
execution_budget:
  per_attempt_timeout_ms: null
  total_completion_deadline_ms: null
  max_external_attempts: null
  max_transient_retries: null
  max_json_reasks: null
  max_provider_fallbacks: null
  retry_backoff_base_ms: null
  retry_backoff_max_ms: null
fallback_candidates: []
```

All budgets must be finite validated positive limits (retry/re-ask/fallback counts may be zero), selected by the platform owner after synthetic evaluation, and compatible with the hosting request limit. No production defaults are approved here. Region enforcement requires a documented, verifiable endpoint/contract mechanism; a region label in this YAML is insufficient.

After prerequisite review, translate the effective policy to documented OpenRouter request fields: `provider.only` with exact approved endpoint slugs, `allow_fallbacks: false`, `data_collection: "deny"`, `zdr: true`, `require_parameters: true`, and verified price limits. `provider.order` expresses preference and alone does not exclude other providers. Account and request allowlists intersect; privacy restrictions may be strengthened, not weakened [S1–S2]. Begin with one exact approved endpoint; any later application fallback must be an explicit local candidate that receives the same controls. Do not send a `models` fallback array: its documented fallback triggers include moderation, which this design treats as terminal [S7]. Reject tools/plugins/BYOK (bring your own provider key)/automatic multi-model routers until separately reviewed.

For an approved EU requirement, verify Business/Enterprise entitlement, onboarded eligible endpoints, regional catalog and contracts, then bind the endpoint to `https://eu.openrouter.ai/api/v1` and the documented guardrail `allowed_data_regions: ["europe"]`; catalog query `region=eu` uses a different value. The regional service documents no global fallback; the global host must never be a retry destination. A host alone cannot prove downstream residency, particularly for BYOK [S3]. For structured output, use `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}` only after the exact endpoint's support and schema are verified; require-parameters filtering and local validation both apply [S5]. None of these controls supplies a contractual approval.

Proposed sequence:

1. Authenticate the caller, derive its workspace from trusted session context, check AI enablement/call capability, classify all outgoing content, and load current platform/workspace approval. **Gate before resolution**: deny unapproved mode, class or purpose before creating candidates.
2. Resolve the pinned profile revision for the existing stage or `call_kind`/role. Intersect exact catalog-supported model and endpoint candidates with approved data-use/retention/region constraints. An empty intersection raises a typed `NoPermittedRoute` with a safe reason; nothing is sent.
3. Produce a route envelope containing requested mode/profile/role, exact model ID, candidate endpoints, approval and catalog revisions, request schema identity, budget and a correlation ID. It is short-lived evidence, not permission to dispatch later without rechecking.
4. A single shared execution owner, built around the existing `tracedCompletion` path, **gates again immediately before each external dispatch**, including every retry, JSON re-ask and fallback. Re-read expiry/revocation and policy/catalog generation; a change invalidates the envelope and fails the completion rather than silently resolving to a new boundary. Reserve budget and a durable pending attempt record before dispatch; inability to persist required audit evidence blocks dispatch.
5. The adapter sends only approved messages/parameters plus supported provider/data controls. Capture actual gateway/inference identity and usage; validate them against the envelope before accepting a result. If the API cannot reliably constrain and evidence required identity/region, do not dispatch that route. Discovery after a call cannot undo disclosure: stop further work and record a policy-divergence incident without accepting its decision.
6. Parse JSON, validate the module's schema/completeness, persist sanitized attempt evidence and aggregate the logical completion. Only validated output reaches module state. Preserve the pending record and an explicit reconciliation-needed state if post-call storage fails; do not turn an unrecorded restricted-data result into a successful stage.

This shared owner covers customer `completionFor`, Accuracy `accuracyCompletionFor`, prompt revision evaluation/replay, ingestion callbacks and decision-example routes. Current direct adapter invocation occurs in `src/modules/kernel/llm-calls.ts:230`; make raw adapters inaccessible as product dispatch entry points. Import-boundary/static checks plus integration tests must catch future direct `provider.complete`/raw-fetch bypasses. Mechanical stages remain callable without an external request; production rejects the test stub (`src/modules/kernel/llm.ts:18–23`).

## 4. Deterministic profiles and exact identities

Distinguish three identities: Synapse adapter ID `openrouter`; gateway model ID (an exact catalog string, not a UI label); actual inference provider/endpoint and served model returned or otherwise evidenced by the gateway. `provider_id: openrouter` alone does not identify the inference provider. Keep requested and actual identities separate in records.

Resolve `(routing_mode, model_profile, profile_revision, call_kind, agent_role)` to one pinned entry in a reviewed mapping artifact. Customer stage bindings reference the same reviewed artifact explicitly; do not guess a stage-to-role correspondence. The entry contains exact gateway model ID, catalog snapshot/expiry, supported parameters/schema capabilities, ordered approved endpoint candidates and price evidence. Ordering is fixed in the reviewed revision, not dynamically selected by "cheapest" or model-name similarity. Mechanical/no-role pairs produce no LLM route.

The required mapping skeleton is deliberately blocked until KAN-96 and catalog review resolve it:

| Profile | Proposer | Critic | Reviser | Judge |
| --- | --- | --- | --- | --- |
| `budget` | “Haiku 5.5” — unresolved ID | “GPT-6 Luna” — unresolved ID | “Haiku 5.5” — unresolved ID | “Sol” — ambiguous, unresolved ID |
| `balanced` | “GPT-6.1 Sol” — unresolved ID | “Sonnet 5.5” — unresolved ID | “GPT-6.1 Sol” — unresolved ID | “Sol” — ambiguous, unresolved ID |
| `quality_focused` | “Sonnet 5.5” — unresolved ID | “Opus 5.5” — unresolved ID | “Sonnet 5.5” — unresolved ID | “Opus 5.5” — unresolved ID |

Every table entry is blocked with no dispatch. These are KAN-96 screenshot/display labels, **not verified public API IDs or verified model availability**, including the ambiguous “Sol”; user clarification is pending. Each LLM call-kind gets its own subset of those role bindings from `CALL_KINDS_META`; no missing entry inherits another role or adapter default. Record the literal labels in KAN-96, verify an official catalog exact ID and endpoint availability, then have the profile owner approve the mapping. Never substitute a similarly named public model, a Codex-internal name, an alias such as an automatic router, or an adapter default. Existing source candidates `x-ai/grok-4`, `anthropic/claude-sonnet-4.5`, `openai/gpt-5.1`, `google/gemini-2.5-pro` (`provider.ts:453–459`) are source facts only, not catalog-verified profile assignments.

Unknown/ambiguous IDs reject configuration. A known but unsupported schema/parameter/model/endpoint rejects the route with the precise capability reason. Removed, unavailable or expired catalog entries fail closed at resolution and dispatch; operator migration requires a newly reviewed profile revision. Identical approved inputs and revisions yield the same selected ID and candidate order; provider load may change availability, but may not widen that order or permission set.

## 5. Error, retry and fallback contract

One logical completion has `max_external_attempts` and `total_completion_deadline_ms`, covering transport retries, JSON repairs and endpoint fallback together. Count an attempt whenever an external request could have been sent, including uncertain network failures; nested loops cannot each reset the budget. Bound each fetch by the lesser of `per_attempt_timeout_ms` and remaining deadline. Waits/backoff consume the same deadline. Stage-wide evaluation/agent cycles also need their existing run/parse limits plus an aggregate external-call/cost budget; the completion budget is not a whole-workspace spending limit.

| Failure | Proposed behavior |
| --- | --- |
| Missing credential | Typed configuration error before dispatch; name only `OPENROUTER_API_KEY`. No automatic switch to direct mode. |
| 401/403 authentication or authorization; 402 billing; daily/spending quota | Terminal error, no retry or blind provider fallback. Safe customer explanation; actionable operator reason without upstream secret/body leakage. |
| Refusal / moderation / content policy / guardrail / region denial | Terminal; inspect `message.refusal`, `finish_reason: "content_filter"` and canonical `error.metadata.error_type`. Do not re-ask or use model fallback to bypass a refusal [S6–S7]. |
| 429 transient rate limit | Retry only if classified transient, approved by retry policy and both count/deadline permit it. Honor valid `Retry-After` (seconds or HTTP date), otherwise bounded exponential backoff; never sleep past deadline or approved maximum. |
| HTTP 500/502/503/504 from gateway | Explicitly eligible transient failures may retry within the same budget and boundary. Do not classify every error-bearing HTTP 200 as transient; classify its documented error code separately. Record possible incurred usage. |
| Network failure / local timeout / connection lost | Completion and billing may be unknown. Default no automatic replay after uncertain dispatch; a separately approved retry policy may allow at most the remaining budget with duplicate-cost warning and evidence. Cancellation is not proof of remote cancellation. |
| Unsupported/removed model, incompatible schema or parameters | Terminal configuration/capability error; no default-model substitution. Empty-body 404 is not a gateway retry exception. |
| No available permitted provider / endpoint outage | Use only the finite pre-approved ordered endpoint/model candidates, after fresh gate and with `max_provider_fallbacks` remaining. Exhaustion yields `NoPermittedRoute`. Never relax region, data use, retention or model constraints, or switch mode. |
| Malformed JSON / business-schema invalid / truncation | Record failed output and reported cost. Re-ask only on the same permitted contract when `max_json_reasks` and shared budget allow; schema errors get bounded safe repair feedback. Exhaustion fails without saving a decision. No swallowed error, fabricated row or fallback to an unrelated model. |
| Actual provider/model divergence | Fail output validation, record expected/actual evidence, stop further dispatches and raise an incident. It is not a normal fallback success. |

The documented in-flight-budget 402 (`error.metadata.limit_source: "openrouter_in_flight_budget"`) differs from ordinary billing [S6]. Initial policy treats all 402 as terminal; supporting this narrow exception later requires explicit classification, approval and bounded Retry-After tests. Do not loosen ordinary billing handling because some 402s are transient. Empty content and unrecognized terminal finish/error conditions also fail explicitly.

Generate a Synapse correlation ID and per-attempt ID, and preserve returned gateway/provider request IDs. These aid reconciliation; they do **not** promise external idempotency (a replay producing no duplicate work or charge). Claim it only if a specific provider contract supports it and tests verify that contract. Show unknown completion/cost explicitly after timeouts; any future reconciliation request must itself be approved and audited.

## 6. KAN-91 trace, usage and cost coordination

The KAN-91 owner should evolve `llm_calls` plus existing run/rollup views in one coordinated migration. Link a logical completion to every physical dispatch attempt, including provider internal retries, JSON re-asks, rejected replies and fallback calls. Retain run/workspace/stage/purpose/role, requested and effective mode/profile and revisions, approval decision/revision, data class, catalog revision, schema identity, candidate/rejected route reasons, gateway adapter/model, actual inference provider/model/endpoint/region (or explicit unknown), safe error category, timestamps/latency, retry/fallback cause, trace/correlation/response IDs and pending/completed/uncertain reconciliation status. Denied routes record metadata without outgoing prompt content and assert zero dispatches.

Opt into supported router attribution with `X-OpenRouter-Metadata: enabled`, recording local dispatch attempts separately from returned router attempts and pipeline context. Cache hits and early failures can omit metadata; absence must remain unknown. Router metadata `region` is the handling edge region, not proof of all downstream processing residency; retain the regional-policy/contract evidence independently. Preserve generation `id` and `X-Generation-Id` when provided [S9]. If a route's approval requires actual attribution that cannot be obtained (including cache behavior), block it or obtain a specifically approved alternative evidence mechanism before enabling it; do not invent provider identity.

Keep provider-reported usage separate from estimated text-based usage. Record individual nullable input/output/total/reasoning/cache counts and their provenance; missing fields remain unknown, not zero. Record `usage.cost` as reported charged credits, with its units/source and response ID separately from a local estimated USD amount; BYOK upstream cost is separate. The deprecated `usage: {include: true}` is not required [S8]. Pin exact model/endpoint pricing, units and retrieval date; no prefix price match or maker-price assumption for authoritative gateway cost. Unknown price/usage gives null/unknown; free pricing is zero only when independently verified for that exact entry. Totals include all attempts and display known subtotal, unpriced count and uncertain calls rather than representing partial evidence as a complete bill. Reconciliation must avoid counting a reported total twice.

Keys stay server-side; redact configured secrets and bearer/key-shaped strings from prompts, replies, errors, logs and exports using the existing redaction path. Secret redaction does not anonymize customer content. 🚩 KAN-91 stores full prompts and replies: confidential facts, names and health information can remain after redaction. Approve a separate Synapse trace policy for access, encryption, retention/deletion, backup handling and exports before restricted processing; default to metadata-only evidence unless content storage is explicitly approved. Preserve required audit metadata with content deletion according to that policy. An external ZDR (zero data retention) setting concerns the gateway/provider; it does not govern Synapse's database, runs, backups or workspace-reset behavior.

## 7. Proposed verification matrix

These are follow-up implementation tests, **not tests executed for this design**. Arrange means set up known input/policy; Act means run the resolver/completion; Assert means check observable output and external dispatch count. Use deterministic fake catalog/policy/transport fixtures and synthetic content; no keys, paid requests or customer content. Test both existing completion entry points and import restrictions. The repository uses TypeScript/Vitest; do not introduce Python tests for this design.

| Case | Arrange / Act | Required assertion |
| --- | --- | --- |
| Selected permitted route | Valid public/synthetic approval, pinned role/profile/catalog, one approved endpoint; resolve and complete valid schema. | Exact intended gateway ID and endpoint sent once; validated contract returned; requested/actual identities and usage linked. |
| Rejected route | Candidate outside approved exact model/provider allowlist. | Safe typed denial, reason and zero dispatches; no default substitution. |
| Unauthorized / tampered configuration | Non-owner route mutation; client-provided approval, endpoint URL or weakened filters; valid owner selects a profile without data approval. | Server authentication/approval scopes win; audited permitted changes only; rejected mutation causes zero dispatches. |
| Request-policy serialization | Approved exact endpoint and schema fixture; capture both kernel requests and retry requests. | Exact `only`, no gateway fallthrough, ZDR/data-use/parameter/schema/price controls and permitted host serialized every time; no `models` bypass. |
| Expiry / revocation / unknown data | Parameterize expired/revoked/missing approval and unknown classification. | NO-GO before resolution; zero dispatches for each. |
| Direct-mode prohibition | Gateway-only workspace requests direct mode; inverse case too. | Denied regardless of direct/gateway credential presence; no mode switch. |
| Restricted data | Confidential without signed scope; personal/health without explicit specialist approval; mixed classes. | Most restrictive outcome, no external content or prompt-bearing denial record. |
| Missing credential | Permitted policy, key unavailable. | Configuration error naming env var only; zero dispatches and no direct fallback. |
| Stale saved route / unsupported ID | Catalog removal, ambiguous KAN-96 label, unsupported schema/parameter, missing role entry. | Save/read/resolve/dispatch reject as applicable; no `servedModel` default path. |
| Provider/model outage | Approved primary unavailable and approved secondary available; repeat with no approved secondary. | Only explicit secondary within same boundary can run; otherwise fail closed. |
| Malformed / schema-invalid / truncated output | Transport returns each invalid payload then valid payload; repeat with exhaustion. | Each failed paid attempt recorded; bounded repairs; valid output only on success, no decision saved on exhaustion. |
| Retry budget | 429 with seconds/date `Retry-After`, transient 5xx, auth/billing/daily quota, malformed 200, timeout/network; advance fake clock. | Classifications match §5; global attempts/deadline include waits and repairs; no replay for terminal/uncertain default cases; unknown cost visible. |
| Fallback divergence | Gateway responds with unapproved actual provider/model or hidden fallback. | Stop, reject result, record incident evidence; no further calls. |
| No permitted provider | All endpoint intersections empty or ZDR/data-use capability absent. | `NoPermittedRoute`, zero dispatches; filters never loosen. |
| Policy change between gates | Resolve revision A, revoke/expire/change policy or catalog before dispatch and again before retry. | Envelope invalidated at fresh gate; no next call, with revision evidence. |
| Catalog / region mismatch | Catalog expired, endpoint region unknown/different, or unsupported region enforcement. | Denial before content leaves; a local region label cannot pass it. |
| Trace / cost evidence | Multiple retries/repairs/fallbacks, missing/partial usage, unknown/exact/free price, pre/post-call storage failure, gateway billed cost. | One attempt record per dispatch; actual vs estimated separated; null ≠ zero; partial totals labeled; pending reconciliation; secrets absent and content policy obeyed. |
| Adapter / kernel bypasses | Exercise Accuracy, customer stages, ingestion, prompt evaluations and replay; import raw adapter or call uncontrolled fetch in product path. | All real dispatches go through shared fresh gate and budgets; static boundary check rejects bypass; non-LLM kind sends nothing. |

## 8. Dated primary-source evidence and open decisions

The following official public pages were retrieved **2026-10-11** by the supporting research task. They substantiate vendor-documented behavior, not customer entitlements, executed agreements or verified live endpoint eligibility. No inference request, model catalog API or ZDR endpoint registry was fetched. There were no reported page-access failures among these sources; account/private-contract/catalog/region checks listed below remain unperformed. No catalog/model/provider/region verification has been inferred from the source-code model list.

| Ref | Official source (retrieved 2026-10-11) | Decision-relevant evidence / limit |
| --- | --- | --- |
| S1 | [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection.md) | `only` restricts; `order` alone does not. Fallback defaults on; required parameters/data collection filtering available. Data-policy labels reflect vendor knowledge, not definitive third-party policy. |
| S2 | [Zero data retention](https://openrouter.ai/docs/guides/features/zdr.md) | `provider.zdr` requires eligible endpoints. No-training ≠ no-retention; implicit memory caching can qualify as ZDR. Third-party plugin/tool backends excluded; unknown policies treated as retaining/training. Endpoint-specific agreements matter. Registry `https://openrouter.ai/api/v1/endpoints/zdr` not fetched. |
| S3 | [In-region routing](https://openrouter.ai/docs/guides/features/in-region-routing.md) | Business/Enterprise EU host, onboarded regional endpoints, no global fallback, guardrail `europe` vs catalog `eu`; unsupported tools/plugins/router combinations error; regional input-output logging skipped. Entitlement/BYOK downstream configuration unverified. |
| S4a | [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection.md) | Prompt/completion persistence described as opt-in; metadata retained; prompt sampling/categorization using a ZDR model is additional processing requiring review when endpoint exclusivity matters. |
| S4b | [Provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging.md) | Training and retention differ. Older retention-routing wording appears inconsistent with newer ZDR documentation; resolve disputed requirements before a promise. |
| S5 | [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md) | Strict `json_schema`, model/endpoint support and `require_parameters`; local schema validation still required. |
| S6 | [Errors](https://openrouter.ai/docs/api-reference/errors.md) | HTTP 200 can contain errors; canonical metadata/refusal/finish reasons; Retry-After; narrowly identified in-flight 402 differs from ordinary billing. |
| S7 | [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md) | `models` can fall back on moderation/context/rate-limit/downtime; actual response model must be recorded. This design avoids that array. |
| S8 | [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting.md) | Native usage/reasoning/cache, `usage.cost` charged credits, generation ID and separate BYOK cost; include-usage flag deprecated. |
| S9 | [Router metadata](https://openrouter.ai/docs/guides/features/router-metadata) | Opt-in provider/model/router-attempt attribution; cache/early-failure gaps; edge-region field does not establish downstream residency. |
| S10a | [Terms](https://openrouter.ai/terms) | §10.2 incorporates public DPA for organizational/commercial use; §5 requires applicable model-term review. Public text is not proof of the applicable customer agreement. |
| S10b | [Privacy policy](https://openrouter.ai/privacy) | Relevant executed DPA/provider terms govern handling; general international-transfer disclosure requires customer-specific review. |
| S10c | [DPA](https://openrouter.ai/data-processing-agreement) | Updated August 26, 2026; separates payloads from operational records. ZDR has legal/malicious-use exceptions and transient buffering; registry designation is not provider-compliance guarantee; Sensitive Data requires agreement. Subprocessor notification excludes AI model-provider processing. |
| S10d | [Enterprise onboarding](https://openrouter.ai/docs/cookbook/get-started/enterprise-onboarding-journey.md) | Describes DPA/security discussions; does not establish execution or approval. No sales contact requested. |

| Unresolved question / blocking evidence | Approval owner | Required resolution before applicable processing |
| --- | --- | --- |
| KAN-93 disposition, acceptable data classes and purposes | KAN-93 decision owner + workspace data owner | Signed GO/RESTRICTED GO/NO-GO scope; workspace/environment, revisions, expiry/revocation. |
| Applicable executed terms/DPA/order forms, Sensitive Data permissions, model-provider agreement coverage and international-transfer safeguards | Legal/procurement + privacy | Confirm actual contractual chain and jurisdiction requirements, including DPA exceptions and model-provider notification exclusions. Public pages alone insufficient. |
| Endpoint-exclusive processing vs gateway sampling/categorization, operational records and legal/malicious-use exceptions | Privacy/legal + security + data owner | Establish whether documented additional processing is compatible; otherwise NO-GO for that scope. |
| Exact endpoint/model availability, capabilities, ZDR/data-use labels, region and price | LLM platform/catalog owner + security | Dated catalog/endpoint registry evidence, regional availability/entitlement, exact endpoint slugs and capability tests; set catalog expiry. No live catalog proof exists here. |
| EU residency guarantees and account entitlement; BYOK/tools/plugins | Security + legal/procurement | Verify all processing legs and agreement scope; initially exclude BYOK/tools/plugins. No fallback to global host. |
| Training, retention, caching and deletion semantics for each provider; conflicting older docs | Privacy/legal + security | Resolve discrepancies and endpoint-specific terms; record approved retention and any exceptions explicitly. |
| KAN-96 “Sol” identity and every screenshot label's public model ID | User/profile owner + catalog owner | Clarify label, verify exact available ID; no substitution. All profile entries blocked until reviewed. |
| Local full-prompt/reply retention, backups, deletion/export/access and failed recording behavior | KAN-91 owner + privacy/security/data owner | Approve Synapse content policy distinct from upstream ZDR; implement metadata-only or approved content retention and durable attempt evidence. |
| Operating budgets and uncertainty/reconciliation policy | Platform owner + cost/operations owner | Finite validated deadlines, retry/re-ask/fallback/run limits and reported-vs-estimated cost display; any live pilot separately authorized. |

## 9. Minimal follow-up scope and milestones

| Milestone | Proposed code ownership | Exit evidence |
| --- | --- | --- |
| Approval and catalog prerequisites | KAN-93 decision owner + legal/privacy/security/data owners; KAN-96 profile owner. No product code. | Signed workspace scopes; contractual/residency/retention evidence; resolved exact catalog entries/capabilities or explicit blocked mappings. |
| Policy/configuration vertical slice | Auth/config owner: both routing APIs, versioned approval/profile storage and both resolvers. | Owner-only audited writes; deterministic mappings; fail-closed validation; expiry/revocation and mode-denial tests. |
| Shared dispatch slice | LLM execution owner: `src/modules/kernel/llm-calls.ts`, both completion wrappers, adapters and error transport. | Fresh per-attempt gate, finite global budgets, constrained provider requests, schema validation and bypass/outage tests. |
| Evidence slice, coordinated with KAN-91 | KAN-91 owner: call schema/migration, `src/accuracy/kernel/cost.ts`, run/Accuracy rollups and trace retention/export views. | Every dispatch has attempt evidence; unknown vs reported/estimated usage/cost retained; retention and secrets tests. |
| Synthetic acceptance then separately approved rollout | Platform/security + workspace data owner. | Matrix passes without paid/customer calls in implementation CI; approved operating budgets and rollback/disable path. Any live synthetic pilot or customer rollout requires its own authorization and KAN-93 outcome. |

Keep scope to optional gateway policy and existing routing topology. No provider-login redesign, production migration, new agent roles, or unrequested stage refactor. Disablement/revocation prevents new dispatches immediately; in-flight outcomes remain explicitly uncertain until evidence is reconciled. No automatic switch to direct mode on disablement.

## 10. Acceptance-criterion crosswalk

| KAN-94 criterion | Design evidence | Implementation status |
| --- | --- | --- |
| Implementation-ready configuration/data flow with dated primary sources and approval prerequisites | §§2–3,8–9; pre-resolution and per-dispatch gates, versioned scoped approval and disabled illustrative config. | Design only; source review and approvals remain prerequisites. |
| Reuse current routing/adapters with precise gaps | §1 baseline/path/line evidence; §§3,6; completed KAN-65/KAN-91 distinguished from proposed controls. | No runtime changes. |
| Tests for selected/rejected routes, unavailable provider/model, schema failure and fail-closed fallback | §§5,7 covers positive/negative paths, all budgets, no-permitted-provider and bypasses. | Proposed matrix; not executed. |
| Same role/profile maps supported exact OpenRouter IDs; unsupported explicit | §4 pinned deterministic mapping contract, blocked role table, no ambiguity/default substitution; §7 catalog tests. | Exact profile assignments blocked on KAN-96 and live catalog verification. |
| Unresolved contractual/residency/retention/model questions plus implementation scope | §§2,8–9 with approval owners and milestone exits. | No operational/legal approval implied. |
| No product or customer-data processing | Document-only deliverable; synthetic fixture tests proposed; no keys/API inference calls required. | Verify changed paths and documentation checks in author report. |

Author verification is documentation review, `git diff --check`, explicit new-file whitespace scanning and changed-path inspection. Runtime tests are unnecessary for this document-only change. Independent reviews and Git/Jira publication belong to the parent task owner.
