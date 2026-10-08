# KAN-40 full-pipeline completion implementation plan

> Execute with the user-selected subagent-driven-development workflow, fresh implementation and review agents.

**Goal:** Complete applicable nonempty mixed benchmarks and close KAN-40 with verified durable evidence.

**Architecture:** Extend native accuracy modules and the existing mixed runner. Reuse pure priority scoring from legacy S8; keep global legacy storage outside isolated replay. Preserve immutable selected inventory and generated child lineage.

**Spec:** docs/superpowers/specs/2026-10-05-kan40-completion-design.md

## Global constraints

- User's latest instruction authorizes necessary completion scope; no repeated approval pauses.
- Existing six tasks at HEAD 00f5c68 are complete; do not repeat them.
- Work only in this isolated checkout. Workers do not commit, push, spawn agents or change Jira.
- Tests use repository Vitest conventions. Actual Postgres fixtures may need authorized escalation.
- No production fake residuals, reference leakage, automatic human approval, source edits or invented dates.

### Task 1: Native modules and full replay completion

Own src/accuracy/modules/partial-split/, a fitting pure priority scoring helper and narrow legacy S8 reuse, mixed-pipeline.ts, mixed-types.ts, mixed-comparison evaluator, relevant tests and usage docs.

- [ ] Write failing behavior tests for exact eligible priority placement, genuine two-child partial split, invalid generated references/provenance, generated lineage and no-edit gate, and full paired nonempty pipeline completion.
- [ ] Implement source/context-bound split proposal with two distinct generated child payloads. Runner gates before durable materialization and validation; retain both child lineage and source context. Preserve original parent and source scoring. Record operational child statuses without pretending the whole parent was closed.
- [ ] Reuse existing pure weighted axes/cue scoring; retain scores, rationale, config identity and exact durable priority placement. Correct generated inventory inputs for ideation and Gantt. Reject invalid/crossed/duplicate output.
- [ ] Update shared terminal invariants and versioned evaluator to reflect actual two-child split, generated coverage/status/priority/plan references and required lineage/gates; preserve original error retention and exports.
- [ ] Prove real Postgres paired completion for nonempty open and partial branches using controlled provider fixtures without replacing native module orchestration. Include final retained call/evaluation/export evidence and original-state preservation. Keep empty branches and failure paths covered.
- [ ] Run focused tests, typecheck, scoped lint, diff checks; report exact commands/results, changed files and limitations. Controller commits then fresh task review/fix loop.

### Task 2: Final verification and Jira closure

- [ ] Resolve review findings, perform final review of completion range with prior review context.
- [ ] Run smallest covering mixed, status, ideation, assembly/experiment approval regression suites and static checks.
- [ ] Publish final branch commits to both required remotes.
- [ ] Add Jira completion comment with acceptance mapping, proof commands/results and live-provider/unscored limitations. Transition KAN-40 to Done and verify response.
- [ ] Follow user lifecycle next-issue selection and arm handoff only after confirmed Done; keep KAN-4 open.
