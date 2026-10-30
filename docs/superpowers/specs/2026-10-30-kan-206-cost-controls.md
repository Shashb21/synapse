# KAN-206 cost controls

Authority: https://synapse21.atlassian.net/browse/KAN-206

Owner-only Development spending controls wrap the existing isolated generation and evaluator workers. Preserve immutable manifests, completed work, source-only generation, no uncertain resends, and shared configuration. No paid experiments.

Show conservative estimates for source/reference preparation, proposer/critic/reviser/internal judge, structural repairs/retries, pair assessments and external evaluation. A snapshot or local preparation has no new provider call; future preparation must not be represented as already paid. Dynamic call counts must expose uncertainty rather than invent a finite total. Use exact provider/model pricing identities; unknown prices stay null, never zero. Explicit acknowledgment is scoped to an execution. USD allowance reserves conservative known-price raw-call bounds atomically before sending; concurrent generation/evaluations share its ledger and cannot oversubscribe. A budget pause retains queued requests and completed sections. Explicit increase/override/resume is audited with actor/time; HTTP retries remain bounded at one and uncertain sends are never resumed.

Keep pre-run estimates, known generation usage costs, known evaluation usage costs, unknown usage and owner-reported totals distinct, including price identity/date where available. Do not treat heuristic token counts as verified billing. After execution allow finite nonnegative spend and validated currency; append corrections with actor/time. Never distribute an execution total to sections without evidence. Expose cost/status data through owner APIs, execution history/logs and a serializable result/comparison contract.

Approach: extend durable worker dispatch and transaction-based persistence, not UI-only checks or a new pipeline engine. Separate cost calculations from storage and UI. Tests use isolated PostgreSQL fixtures and provider stubs only, with Vitest and Playwright. Verify TypeScript and applicable lint. PR targets KAN-200 under the ticket-specific integration workflow and remains open; no merge is authorized.
