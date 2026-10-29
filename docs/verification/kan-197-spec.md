# KAN-197 — Make errors and warnings clear and actionable across control panel and workspaces

+## What and why

Owner feedback on KAN-109 (2026-10-29): every error, warning and failed-action message shown in the control panel AND actual workspaces must be understandable to a non-technical person and explain what to do next. This applies to the platform owner too; being an administrator should not require reading database errors or provider response bodies.

Confirmed evidence: routing-panel.tsx displays degraded_reason directly; run-stage-button.tsx and pipeline-runner.tsx display server errors and fall back to stage IDs/HTTP status; workspaces/model.ts throws raw server error text or "Request failed (HTTP ...)"; workspace-settings.tsx and workspace-contents.tsx fall back to "That did not work."; platform/action-dialog.tsx and provider-panel.tsx use "Action failed". Persisted run/comparison errors also render directly in some views. Existing customerErrorMessage/ProviderError handling (KAN-68/KAN-70) already covers some AI failures: preserve and extend it rather than creating a competing translation system.

## Required behavior

1. Inventory all currently reachable user-visible error/warning paths in control-panel and workspace journeys, including shared controls, server-rendered pages, form validation, sign-in/session errors, imports/uploads, AI runs, evidence review, prioritization, tactics, timelines, workspace/member/settings changes and historical run/comparison failures. Record each surface, source of message, known failure cases, chosen wording, recovery and verification. Inspect related owner run/diagnostic views wherever the same failures are shown. This inventory is a completion checklist, not a substitute for updating the messages.
2. Each message identifies the action/problem in familiar terms, why when reliably known, and the next permitted action. Say whether the user can correct it, wait, sign in, or needs a workspace owner/platform administrator. Use business task names rather than S-stage codes as the main explanation. Keep distinct cases distinct: invalid input, permissions/session expiry, changed/stale data, missing AI setup, billing/daily limit versus temporary rate limit, service outage, unsupported/corrupt/oversized file, incomplete result and unexpected failure.
3. Extend existing error ownership at the server/API boundary and shared browser request helpers as appropriate. Retain useful field-specific validation. Unknown exceptions get a safe action-specific explanation; do not render arbitrary exception.message, raw provider replies, SQL, parameters, stack traces, JSON or HTTP codes as the main message. Do not rely only on a growing list of forbidden-string regexes. Keep diagnostics in authorized server logs; any optional on-screen technical detail must be sanitized, explicitly labelled and permitted for that role. No secrets or other workspace data may appear, even behind expansion.
4. Keep primary problem and recovery visible without expanding details. Offer real working retry/correction/navigation actions where available. Customer messages must not link to owner-only settings or tell the customer to change server credentials. Owner messages should give understandable setup steps and links the owner can use.
5. State save/outcome truthfully. "Nothing was saved" or "Your work is saved" requires evidence for that operation; account for partially completed import/pipeline steps. When a lost response means the outcome is unknown, say it could not be confirmed and guide the user to check current state before repeating a consequential action. Preserve drafts and completed work, clear pending state, and prevent duplicate submissions; do not introduce automatic unsafe retries.
6. Reuse existing alerts, field associations and status announcements. Errors remain near the relevant action/field and readable at normal body size; do not communicate severity through colour alone. Error visibility must not disappear into optional help.

Example intent (adapt to confirmed context): replace an internal query failure with "We couldn't check the AI settings. Try loading them again. If this continues, contact your Synapse administrator." Do not invent the underlying cause or make a non-working Retry button.

## Acceptance and verification

- [ ] Inventory covers every currently reachable control-panel/workspace message path; each is updated or explicitly reviewed as already clear, with no unexplained "Action failed", stage-code-only or raw server exception presentation remaining.
- [ ] Each failure explains the problem and a feasible next step for the current role. Unknown failures still provide safe guidance without inventing a diagnosis.
- [ ] Known validation, expired session/access, stale write, offline/non-JSON response, missing configuration, provider quota/outage and upload/partial-pipeline cases have focused behavioral tests; successful flows remain intact.
- [ ] Tests prove raw database/provider failures and sample secrets cannot reach page/API error copy for customers or owners; authorized diagnostics retain useful safe context.
- [ ] Failed action tests verify retained input, honest saved/partial/unknown outcomes, recovery and no duplicate destructive action after an uncertain response.
- [ ] Browser checks cover the control panel and representative actual workspace journeys, desktop and 390px widths, 200% zoom, keyboard/focus and announced errors. Record exact commands/results and inventory coverage.

## Ownership and coordination

Parent KAN-109; repository https://github.com/Shashb21/synapse ; local /Users/calixtan/personal-projects/synapse.  
KAN-192 owns reliable configuration loading/unknown state and retry, KAN-193 readiness, KAN-195 switch pending/success/recovery. This task owns the cross-surface plain-language message standard and application; reuse their state and actions rather than rebuilding them. KAN-68/KAN-70 completed narrower customer AI error work; extend those regressions, do not reopen completed fixes. Re-fetch siblings and inspect current working tree before implementation. Preserve authorization, scientific terminology/meaning, routing policy, audit rules and existing uncommitted KAN-109 improvements. This is planned implementation work, not a completed fix.
