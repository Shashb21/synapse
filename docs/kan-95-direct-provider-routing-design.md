# KAN-95: policy-bound direct-provider routing

Design date: **2026-10-11**. Code baseline: **main `d541bc3`**. This is a design only: no product changes, inference calls, customer data transfers, credentials, migration or operational approval. KAN-93 remains **To Do, unassigned, with no comments or approval decision**, according to the task owner's fresh Jira read. Every direct provider needs its own approval before use.

`routing_mode = direct | openrouter` selects the processing path. Independently, `model_profile = budget | balanced | quality_focused` selects a reviewed role-to-model mapping. For example, `direct + balanced` still requires an exact approved provider, model and endpoint for each role; the profile name grants no permission. A direct route sends requests to a provider's approved native API, with no OpenRouter account or key dependency.

This proposal extends the **same shared policy resolver and dispatch owner** defined in [KAN-94](kan-94-openrouter-routing-design.md), using KAN-91's existing call evidence store. A resolver chooses an authorized route; the dispatch owner is the single component permitted to send it. KAN-94 §§2–3, 5–6 supply the shared approval, execution-budget and trace contracts. This document adds direct-provider requirements rather than a competing routing engine.

## 1. Current adapters and precise gaps

Source references below are at `d541bc3`; provider and both kernel routing files are unchanged from KAN-94's `d92ebc3` baseline. The server reads API keys from environment variables (`src/modules/llm/api-keys.ts:11–28`); its status view reveals presence and model lists, not values (`:56–82`). Key presence proves neither authorization nor model access.

| Adapter / source | Current native endpoint and authentication | Exact repository model candidates, default first | Direct-design gap |
| --- | --- | --- | --- |
| `anthropic-claude`, `src/modules/llm/provider.ts:301–375` | `https://api.anthropic.com/v1/messages`; `ANTHROPIC_API_KEY` in `x-api-key`; `anthropic-version: 2023-06-01`; optional `ANTHROPIC_WORKSPACE_ID` header. Base override: `ANTHROPIC_BASE_URL`. | `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-4-5-20251001` | No structured schema. Temperature omission uses a model-name heuristic (`:305–306`), not a verified capability record. Text blocks are joined; refusal, truncation and empty text fail. |
| `openai`, `provider.ts:377–394` | `https://api.openai.com/v1/chat/completions`; bearer `OPENAI_API_KEY`; base override `OPENAI_BASE_URL`. | `gpt-5.1`, `gpt-5.1-mini`, `o4-mini` | Shared helper sends `temperature` and deprecated `max_tokens` unconditionally; no JSON schema. Verify parameter support for each exact model. |
| `google-gemini`, `provider.ts:396–444` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`; `x-goog-api-key: GEMINI_API_KEY`; base override `GEMINI_BASE_URL`. | `gemini-3.8-flash`, `gemini-3.1-pro-preview` | Sends temperature, `maxOutputTokens` and `responseMimeType: application/json`, but no schema. Prompt blocks and unsupported finish conditions fail. |
| `xai-grok`, `provider.ts:280–299` | `https://api.x.ai/v1/chat/completions`; bearer `XAI_API_KEY`; base override `XAI_BASE_URL`. | `grok-4`, `grok-4-fast`, `grok-3` | Shared Chat Completions helper sends no JSON schema. Public retirement evidence makes `grok-3` unsuitable for exact-identity routing; see §4. Global endpoint does not establish residency. |

The `*_MODELS` overrides and static arrays (`provider.ts:71–75`) are configuration inputs, **not remotely verified availability**. All five adapters, including OpenRouter, are registered; defaults are Grok followed by Claude and OpenAI (`:447–484`). Do not inherit that generic registry or fallback chain into an approved direct route.

| Shared behavior to reuse | Exact implementation gap to close |
| --- | --- |
| Customer stage configuration and Accuracy `call_kind`/role topology | Customer reads normalize saved IDs (`src/modules/kernel/routing.ts:108–126`); Accuracy does likewise (`src/accuracy/kernel/routing.ts:82–83`). `servedModel` replaces unsupported IDs with defaults (`provider.ts:490–502`). Reject invalid direct configuration instead. |
| Existing authenticated configuration and audit paths | Customer setters validate models (`routing.ts:154–177`); Accuracy validates provider but accepts a model string (`accuracy/kernel/routing.ts:100–133`). Apply one exact-route validator on write, read and execution. Retain owner gates in `src/app/api/control/route.ts:37–45,105–118,151–167` and `src/app/api/accuracy/routing/route.ts:100–148`. |
| Existing completion entry points | Customer and Accuracy choose the first keyed provider, using default models for fallbacks (`kernel/routing.ts:195–228`; `accuracy/kernel/routing.ts:136–187`). These are selection-time fallbacks, not runtime outage handling. Replace this behavior for policy-bound routes with reviewed exact tuples. |
| Explicitly empty fallback configuration | Accuracy's setter restores defaults for `[]` (`:122`); Accuracy API treats empty input as keep-current (`src/app/api/accuracy/routing/route.ts:54–68`). Preserve `[]` as no fallback throughout both kernels, APIs and saved configuration. |
| Raw-string adapter result and caller parsing | `provider.ts:45–60` returns text. Customer allows three JSON re-asks (`kernel/routing.ts:265–315`); Accuracy parses once (`accuracy/kernel/routing.ts:255–262`). Add model-specific schema serialization and local business-schema validation while preserving caller return contracts. |
| Existing `tracedCompletion` | KAN-91 records prompts/replies, requested provider/model, usage and cost (`src/modules/kernel/llm-calls.ts:20–57,74–106,181–245`). Its raw adapter call at `:230` becomes an internal dispatch boundary; hidden transport retries need separate attempt evidence. |
| Existing HTTP handling | `provider.ts:81–130` allows four attempts for some 429s, 503 and empty-body 404, with waits capped at 60 seconds. Fetch timeout defaults to 120 seconds (`src/modules/llm/provider-error.ts:135–171`). Replace independent counters with the shared finite budget; do not use empty-body 404 to justify identity substitution. |

## 2. Approval and processing boundary

Reuse KAN-94's data-class decision framework: public/synthetic evaluation is conditional on approval; confidential data requires an expressly restricted scope; personal and special-category/health data remain NO-GO pending the relevant privacy/legal and customer decisions. Mixed content takes the most restrictive class; unknown class is denied. This design itself authorizes no evaluation, even with synthetic inputs.

KAN-93's accountable decision owner must record the disposition. Legal/procurement verifies each provider's applicable agreement, data-processing agreement and subprocessors; privacy reviews personal/health data, transfers and purpose; security reviews endpoint, region, retention and access controls; the workspace data owner approves the dataset and purpose. These are responsibility roles, not approvals already obtained. Approval for Anthropic does not authorize OpenAI, Google, xAI or OpenRouter. Configuration-owner access does not confer processing approval.

| Direct provider | Public evidence relevant to approval | Required account/contract evidence before enablement |
| --- | --- | --- |
| Anthropic | Retention and zero data retention (ZDR) eligibility vary by model and feature; some documented models require retention absent express authorization. Structured-output schemas can be cached up to 24 hours [A2–A3]. | Executed scope, exact model/feature eligibility, processing/storage location and permitted schema/content retention. No blanket ZDR claim. |
| OpenAI | Chat Completions documents no training, default abuse-monitoring retention and conditional ZDR eligibility; regional and caching conditions apply [O3]. | Organization/project entitlement, applicable agreement, exact endpoint/model/feature, processing versus storage regions and effective retention controls. No inference from a configured key. |
| Google Gemini API | Terms distinguish service/account conditions. For users in the EEA, Switzerland or UK, Paid Services data-use terms also apply to unpaid services. Paid-service data-use restrictions do not establish ZDR or a particular residency [G3]. | Applicable account, billing and jurisdiction terms; DPA and data class/purpose restrictions; abuse logging, cache/storage and location commitments. Do not equate this Developer API with a separately reviewed Vertex AI deployment. |
| xAI | Default request/response retention is documented as 30 days; ZDR is a team-level setting. The global endpoint may route across regions; the documented US endpoint has its own model eligibility [X3–X4]. | Effective team setting, agreement, exact regional model eligibility and retention scope. No regional-to-global fallback; no EU capability established by this review. |

An endpoint is an approved combination of HTTPS origin, permitted path shape, provider identity and supporting regional evidence. Resolve a server-owned endpoint ID; reject arbitrary URL overrides, user information in URLs, query strings/fragments, deceptive host suffixes and unapproved proxies, including direct-provider base URLs pointing to OpenRouter. Validate model path segments separately. Reject redirects by default; any future redirect support must authorize the destination **before** forwarding credentials or content. Reinforce this with an outbound-network allowlist. A hostname alone cannot prove processing or storage residency.

Environment/configuration exports may contain credential variable names, presence flags, approved endpoint IDs and policy revisions, never values or authorization headers. Review exported metadata and content under the workspace policy; sanitize upstream errors too. No OpenRouter key or account is required by direct resolution, dispatch or observability. A present `OPENROUTER_API_KEY` must have no effect on a direct run.

## 3. Shared configuration and direct data flow

The shared policy binds workspace, environment, data classes, purposes, mode, profile/catalog/policy revisions, exact provider/model/endpoint tuples, regions, external and internal retention, approving identities, evidence and expiry/revocation. Effective permission is the intersection of platform and workspace policies. Missing, unavailable, expired, revoked or stale evidence denies dispatch.

Illustrative **non-runnable** configuration follows. Nulls and empty collections deliberately leave it disabled; these proposed fields are not native vendor API parameters. No budget or production default is approved here.

```yaml
enabled: false
workspace_id: SYNTHETIC_REVIEW_WORKSPACE
environment: review
routing_mode: direct
model_profile: balanced
profile_revision: null
policy_revision: null
approval:
  decision: NO-GO
  revision: null
  approved_by: []
  evidence_refs: []
  allowed_modes: []
  allowed_data_classes: []
  allowed_purposes: []
  approved_at: null
  expires_at: null
  revoked_at: null
catalog: {revision: null, verified_at: null, expires_at: null}
role_bindings: {}            # exact reviewed call-kind/role or customer-stage bindings
primary: {provider_id: null, model_id: null, endpoint_id: null}
fallback_candidates: []     # explicit exact tuples only; empty means none
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
```

All execution limits must be finite, validated and compatible with hosting limits; retry/re-ask/fallback counts may be zero. Run-level call/cost limits bound repeated completions as well. The profile artifact supplies exact tuples only after approval and account/catalog checks; environment model lists cannot override it.

1. Authenticate, derive workspace/environment from trusted context, check AI capability and classify outgoing content. Gate mode, purpose and data approval **before resolution**.
2. Validate the **entire saved primary and fallback configuration** against the current direct contract. Any OpenRouter entry, stale ID, unsupported parameter/schema, unknown endpoint or conflicting revision rejects the configuration; do not silently filter the offending entry, normalize through `servedModel`, downgrade or use a generic default.
3. Resolve the pinned profile's existing call-kind/role or explicit customer-stage binding to the exact approved route. Empty eligible set raises a typed `NoPermittedRoute` with a safe reason and zero network calls. The complete profile must pass configuration validation; no implicit cross-role inheritance. Mechanical/no-role stages remain no-call paths.
4. Create the same short-lived route envelope used by KAN-94, including revisions, exact candidates, schema identity, budget and correlation ID. The shared dispatch owner rechecks policy/catalog/approval and credentials **immediately before every physical attempt**, including frozen routes, retries, repairs and fallbacks. A revision change invalidates the completion; it does not silently resolve to another route.
5. Reserve global budget and durable pending attempt evidence, then call the approved native adapter. Missing audit storage blocks dispatch. Serialize only catalog-verified parameters. Raw `provider.complete` and uncontrolled fetch are not public product entry points; enforce import boundaries and test all existing Accuracy, customer, evaluation/replay, ingestion and decision-example paths through the shared owner.
6. Capture native response identity and usage, reject identity divergence, validate output locally and finalize evidence before returning a successful result. Post-call storage failure leaves a pending/reconciliation-needed record and fails the restricted completion; a paid but unrecorded reply is not a successful stage. Discovery after dispatch cannot undo disclosure; divergence stops subsequent requests and requires incident review.

Missing credentials, retries, model outages and empty candidate sets **cannot change `routing_mode`**. Explicitly approved direct fallbacks may only use exact tuples in the frozen ordered list, with independent provider approval and a fresh gate. Default fallback is `[]`; enabling another provider requires review, not a similarity or cost heuristic.

## 4. Exact models, profiles and native capabilities

Keep separate: repository candidate string, publicly documented API ID, authenticated account/endpoint availability and approved profile assignment. None proves the next. A catalog record must capture exact ID (snapshot/version where supported), provider/endpoint, model lifecycle and alias/redirection behavior, region eligibility, supported parameters/schema subset, pricing evidence, retrieval/expiry and approval. If identity cannot be constrained and evidenced to the required scope, do not enable the route.

| Exact source candidates | Public documentation check on 2026-10-11 | Decision |
| --- | --- | --- |
| `claude-sonnet-5-5`, `claude-opus-5-5` | Listed in Anthropic overview [A1]. | Public IDs only; account eligibility and profile assignment unverified. |
| `claude-haiku-4-5-20251001` | Not independently verified in the consulted overview. It lists `claude-haiku-5-5`, a different ID [A1]. | Unverified candidate; do not substitute the newer name. |
| `gpt-5.1` | Official model page lists it and snapshot `gpt-5.1-2025-11-13`, and marks the model **Deprecated** [O1]. | Requires explicit lifecycle/account decision; neither alias nor snapshot is approved here. |
| `gpt-5.1-mini`, `o4-mini` | Not independently verified in this review. | Unverified, not a claim of nonexistence; block until exact verification. |
| `gemini-3.8-flash`, `gemini-3.1-pro-preview` | Listed in Google's model overview [G1]. | Public IDs only; account/region/capability and preview-risk approval remain open. |
| `grok-3` | xAI retirement notice documents automatic redirection to `grok-4.3` [X1]. | Reject before dispatch: accepting a retired ID risks sending data to an unapproved model. Replacement is not an approved substitution. |
| `grok-4`, `grok-4-fast` | Exact strings not independently verified. Retirement notice lists suffix variants such as `grok-4-0709` and `grok-4-fast-reasoning` [X1]. | Do not equate source strings with suffix variants; verify exact identity and redirect behavior. |

The KAN-96 screenshot assignments remain exactly as provided:

| Profile | Proposer | Critic | Reviser | Judge |
| --- | --- | --- | --- | --- |
| `budget` | Haiku 5.5 | GPT-6 Luna | Haiku 5.5 | Sol |
| `balanced` | GPT-6.1 Sol | Sonnet 5.5 | GPT-6.1 Sol | Sol |
| `quality_focused` | Sonnet 5.5 | Opus 5.5 | Sonnet 5.5 | Opus 5.5 |

**Every assignment is unresolved and blocked pending KAN-96**, including labels resembling documented public models. “Sol” is ambiguous; Codex display names are not public API IDs. Do not infer a mapping to a similarly named API model. KAN-96 must record the user's intended identities; the profile owner then approves exact catalog/account-verified direct tuples for each applicable role. `CALL_KINDS_META` (`src/accuracy/kernel/contracts.ts:5–45`) determines role applicability. Customer stages require explicit bindings to this artifact. Unknown, missing, unavailable or ambiguous assignments produce a clear blocked-entry report and zero dispatches. Identical approved inputs and revisions yield the same candidate order; no dynamic “cheapest” replacement.

Structured output means requiring a machine-checkable JSON shape; valid JSON alone does not establish required fields, types or business rules. Keep local validation for every provider, including null handling, ranges and completeness. Native support differs:

- **Anthropic:** documented `output_config.format` uses JSON schema; the older field is deprecated. Supported schema constraints and incompatible features require exact model checks. Do not put sensitive content in schema definitions; schema caching has separate retention implications [A2]. Replace name-regex parameter guesses with capability records.
- **OpenAI:** Chat Completions supports `response_format` with `json_schema` where the exact model supports it. `max_tokens` is deprecated in favor of `max_completion_tokens`, which includes reasoning tokens; temperature support must be checked rather than blindly forwarded [O1–O2]. This design does not require an unrelated migration to another API.
- **Google:** the consulted structured-output guide labels Generate Content as legacy and documents a supported schema subset [G2]. Verify the exact REST schema field and model/endpoint contract before implementation; the existing JSON MIME type is insufficient.
- **xAI:** JSON schema is supplied through `response_format.json_schema`; some accepted constraints are not enforced by the service [X2]. Local validation remains authoritative. Verify exact model and native endpoint compatibility.

Unsupported schema or parameter requirements reject the route before dispatch; never silently drop constraints to make a call succeed. Normalize provider-specific refusal, safety blocks, HTTP-200 error bodies, empty content and truncation to explicit errors. Current shared Chat Completions handling (`provider.ts:257–277`) does not cover every refusal/content-filter form.

## 5. Failures, retries and fallbacks

Use KAN-94 §5's one logical-completion deadline and external-attempt cap. Every HTTP retry, repair and approved fallback consumes that same budget; nested loops cannot reset it. A timeout may still have incurred work and cost. Native correlation/request IDs aid reconciliation but do not prove idempotency (that replay causes no duplicate work or charge).

| Condition | Direct behavior |
| --- | --- |
| No approved route, expired/revoked approval, stale saved primary **or fallback**, unknown region/catalog | Deny before dispatch with `NoPermittedRoute` or a precise configuration/policy error. No substitution or mode switch. |
| Missing provider credential | Terminal configuration error naming only the expected environment variable. Do not choose another provider because its key exists. |
| Authentication/authorization, billing/daily quota, refusal/moderation/policy denial | Terminal; no repair, retry or fallback to evade the condition. Sanitize operator and customer errors. |
| Unsupported/retired/unavailable exact model, schema/parameter incompatibility | Terminal capability/configuration error. Require a reviewed profile revision; no adapter defaults, aliases or undocumented substitution. |
| Explicitly classified transient 429/503 or approved transient server error | Retry same approved tuple only within count/deadline and fresh gate. Honor seconds/date `Retry-After`; if the required wait exceeds remaining deadline or policy maximum, fail rather than retry early. |
| Network loss or timeout after uncertain dispatch | Default no automatic replay; record uncertain completion and cost. Any future replay policy requires approval and shared-budget enforcement. |
| Eligible temporary endpoint outage | An explicitly approved direct fallback may run only for an approved failure category and within remaining budget. Exhaustion fails closed. Never switch to OpenRouter, global region or a default model. |
| Malformed JSON, invalid business schema, truncation | Record failed output/usage; bounded same-contract repair only if policy permits and budget remains. Exhaustion fails without saving a decision. Refusals are not repairable schema failures. |
| Actual model/provider/endpoint divergence | Reject result, record expected/actual evidence, stop subsequent attempts and raise an incident. Do not treat silent vendor redirection as successful fallback. |

## 6. KAN-91 evidence, cost and retention

Extend KAN-91 records and rollups in coordination with its owner. Record logical completion and each physical dispatch, including failed and uncertain attempts: workspace/environment/run/stage/role/purpose; requested and effective mode/profile/revisions; approval/catalog/schema revisions; exact requested provider/model/endpoint; evidenced actual provider/model/region; native request/response IDs; actual sent parameters; timing, failure category and retry/fallback cause. In direct mode gateway identity is **null / not applicable**, never inferred as OpenRouter. Unknown actual fields remain unknown; the requested model is not proof of the served model. If approval requires identity or residency evidence the provider cannot supply, block before enabling it.

Reserve durable pending metadata before dispatch and reconcile afterward as in §3. The present trace wrapper preserves a received reply when storage fails (`llm-calls.ts:199–225`); restricted direct processing must instead fail with reconciliation evidence. Denials store safe metadata without outgoing prompt content.

Keep provider-reported token usage distinct from local estimates, with nullable input/output/reasoning/cache counts and provenance. Existing parsing sometimes sums missing components as zero (`provider.ts:139–164`). Exact dated model/endpoint pricing must include currency, units, cache/reasoning treatment and any region terms. Store an evidenced billed amount separately from an estimate; do not call a token-price calculation the invoice.

Unknown price or required usage stays **null/unknown**, not zero. Current prefix matching and the older unknown-to-zero estimator (`src/accuracy/kernel/cost.ts:63–84,91–127`) cannot establish authoritative direct cost; Accuracy must not convert a null traced cost to that estimate (`accuracy/kernel/routing.ts:223–235`). Rollups show known subtotal, unpriced attempts and uncertain calls across retries/repairs/fallbacks. Verified zero price is distinguishable from missing evidence; reconciliation must not double-count reported totals.

🚩 External ZDR does not delete Synapse's full prompts, replies, runs or backups. Existing call records survive workspace reset (`docs/traceability.md:27–63`). Separately approve internal content access, encryption, retention/deletion, backup handling and exports. Default restricted evidence to metadata-only unless content storage is expressly permitted. Secret redaction is necessary but does not anonymize personal or confidential content. Preserve audit metadata according to the approved policy when deleting content.

## 7. Proposed implementation verification

These are future tests, **not runtime tests executed for this document**. Use the repository's TypeScript/Vitest fixtures and fake transport with synthetic content; no real provider requests. Arrange sets up policy/input, Act invokes resolution/completion, Assert checks output and every outbound attempt. Exercise both kernels and APIs; keep an OpenRouter key present in relevant tests to prove it cannot activate direct-mode fallthrough. Count all outbound hosts, including redirects and retries, not just selected adapter names.

| Scenario | Required observable assertion |
| --- | --- |
| Approved direct primary | Exact approved native URL/model/parameters sent once; valid local schema result and linked evidence; **zero OpenRouter calls**. |
| Approved direct fallback / no fallback | Only explicitly approved exact secondary tuple can run for an eligible failure; `[]` remains empty through both APIs/save/read/dispatch. **Zero OpenRouter calls** in both cases. |
| Saved primary conflicts with direct mode | OpenRouter, stale/unknown/retired ID or endpoint in primary rejects entire configuration; zero total dispatches, including OpenRouter. |
| Saved fallback conflicts with direct mode | Valid primary plus one OpenRouter/stale/unapproved fallback still rejects entire configuration before primary dispatch; no silent filtering, zero total calls. |
| Missing key / no approved route | Present gateway and other-provider keys cannot activate substitution; typed failure and zero total calls. |
| Transient retry / outage | 429/503, Retry-After seconds/date, exhausted budget and outages stay within exact approved direct tuples and global deadline; zero OpenRouter calls. Required waits are not shortened. |
| Terminal and uncertain failures | Auth, billing, quota, refusal, unsupported schema/model and timeout classifications match §5; no unauthorized replay or fallback and zero OpenRouter calls. |
| Raw adapter / other entrypoint bypass | Customer, Accuracy, evaluation/replay, ingestion and decision-example dispatch all require shared gate; static import restrictions reject direct `complete`/uncontrolled fetch; bypass attempts send nothing. Mechanical stages send nothing. |
| Policy changes between resolution and dispatch/retry | Revocation, expiry, policy/catalog generation change invalidates frozen envelope before next call; no re-resolution, zero OpenRouter calls and correct revision evidence. |
| Malicious base URL / redirect | Gateway override, deceptive host, userinfo, path manipulation, query/fragment and unapproved redirect fail before credentials/content are sent; zero OpenRouter and zero unapproved-host calls. |
| Unavailable exact model / KAN-96 mapping | Removed/redirecting model, ambiguous Sol, any unresolved screenshot assignment, missing role or expired catalog blocks without default substitution; zero dispatches. |
| JSON/schema failure | Malformed, null/missing fields, wrong types/ranges and truncation fail or repair only within approved shared budget; no invalid decision saved, all attempted costs represented. |
| Unknown cost / audit storage failure | Null stays unknown through both estimators/rollups; partial totals labeled; one record per attempt; pre-call storage failure sends nothing, post-call failure leaves reconciliation state. |
| Profile/run/workspace isolation | Concurrent modes/profiles/revisions/workspaces cannot share or mutate another envelope; direct run never borrows gateway credentials/candidates. Unauthorized configuration or self-asserted approval rejected. |
| Identity and retention evidence | Divergent actual identity rejects and stops further calls; missing metadata stays unknown; secrets absent and prompt storage/export/deletion follow internal policy. |

## 8. Dated primary sources and unresolved evidence

All sources below were opened on **2026-10-11**. They establish vendor-documented behavior only. No public-page access failures were encountered. Authenticated model catalogs, account entitlements/settings, live endpoint checks, prices and private/executed agreements were **not accessed**; no API keys or inference calls were used. “Not verified” above means this review did not establish the claim, not that a model does not exist.

| Ref | Official source | Use / limit |
| --- | --- | --- |
| A1 | [Anthropic model overview](https://platform.claude.com/docs/en/models/overview) | Public exact IDs; not account or screenshot mapping approval. |
| A2 | [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) | Schema syntax/subset, incompatibilities and schema caching. |
| A3 | [Anthropic API/data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) | Model/feature-specific retention eligibility; contractual verification required. |
| O1 | [OpenAI GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1) | Documented ID/snapshot, capabilities and deprecation. |
| O2 | [OpenAI Chat Completions create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) | Parameter contract and deprecations; model-specific support still matters. |
| O3 | [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data) | Retention/ZDR/regional conditions; actual entitlement not established. |
| G1 | [Google model overview](https://ai.google.dev/gemini-api/docs/models) | Public model candidates, not account access. |
| G2 | [Google Generate Content structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) | Legacy API label and schema subset; exact REST serialization remains to verify. |
| G3 | [Gemini API terms](https://ai.google.dev/gemini-api/terms) | Account/jurisdiction-dependent data-use terms; no blanket ZDR/residency. |
| X1 | [xAI May 15 retirement migration](https://docs.x.ai/developers/migration/may-15-retirement) | Retired IDs and automatic replacements; block implicit substitutions. |
| X2 | [xAI structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) | Schema request format and enforcement limitations. |
| X3 | [xAI security FAQ](https://docs.x.ai/developers/faq/security) | Training permission, default retention and team-level ZDR. |
| X4 | [xAI regions](https://docs.x.ai/developers/advanced-api-usage/regions) | Global versus US endpoint; documented US models `grok-4.7`/`grok-4.6` do not establish regional eligibility of source candidates. |

The remaining decisions are explicit: KAN-93 approval for each provider/data scope; KAN-96 screenshot identities; account/endpoint/catalog lifecycle checks for every exact ID; exact native schema/parameter verification; region and retention evidence; finite operating budgets; internal trace policy; dated exact pricing. Regional guarantees must cover the approved feature set, not be extrapolated to tools/files or other services. Public sources do not resolve private contracts or determine legal suitability.

## 9. Minimal follow-up milestones and acceptance crosswalk

1. **Approval and mapping evidence:** KAN-93 owners record per-provider scope; KAN-96 resolves intended labels. Platform owner creates expiring catalog/capability/endpoint records, explicitly addressing deprecated or redirecting candidates. Until then, routes remain disabled.
2. **One shared routing contract:** With KAN-94 owner, add server-owned mode/profile/revision envelopes, whole-config validation, exact tuples and consistent `[]` semantics to both kernels/APIs. Preserve authenticated audit paths and no-call stages; implement no default substitution for policy-bound routes.
3. **One enforced dispatch path:** Add native endpoint allowlists, per-attempt fresh gates, global budgets, provider parameter/schema validation and bypass restrictions. Start with one approved synthetic direct route only after separate authorization; fake-transport tests require no live call.
4. **KAN-91 evidence and release verification:** Coordinate per-attempt pending/final records, actual identity, nullable usage/cost and retention controls. Run §7 before any separately authorized staged enablement; this document performs no migration or rollout.

| KAN-95 acceptance requirement | Design coverage and current limit |
| --- | --- |
| Configuration/data flow and minimal code gaps | §§1–3 enumerate current adapters, source references, shared owner, disabled example and precise changes. No competing engine or product edits. |
| Zero gateway network calls in direct mode | §§2–3 and §7 cover primary/fallback, stale primary/fallback, keys, retries/outages, bypass, changes and malicious URLs. Proposed tests are not executed implementation evidence. |
| No-approved-route failure / no substitution | §§3–5 require explicit failure before dispatch, entire-config rejection and exact approved fallbacks only; `grok-3` redirection is blocked. |
| Three profiles with exact-ID resolution and unavailable entries | §4 preserves all screenshot assignments and defines exact resolution. **All mappings remain unresolved/blocked pending KAN-96**, with exact source/public-ID evidence and unavailable/unverified distinctions reported; no fabricated complete mapping. |
| Approvals, observability, costs and follow-ups | §§2, 6, 8–9 bind per-provider approval, native attribution, complete attempt evidence, unknown costs, retention and owners. Account/contracts/pricing remain unverified. |
| Documentation only / no unapproved data | This file and task report only; public documentation and source inspection only. No runtime tests, inference, customer data, credentials, configuration change or operational approval. |
