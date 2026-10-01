# KAN-34 Task 6 report — verification and documentation

## Design decisions

- Document the existing experiment API and persistence boundaries rather than
  introducing a documentation-only wrapper or alternate execution path. The
  source workspace remains the reader-facing scope; the copied workspace is
  private implementation state.
- Treat comparisons as attributed only when source, baseline, pack, evaluator,
  and condition identities match. The rejected alternative was comparing only
  a prompt or model label, which would misattribute changes in data, gold
  content, or evaluator behaviour.
- Describe evaluator-v1 as conservative and versioned: partial matches remain
  evidence but receive no exact-metric credit. The rejected alternative was to
  count lexical partials as exact matches, which would rewrite the meaning of
  retained scores.

## Behaviours completed

- Added a minimal authenticated local `single_call` request and the `pipeline`
  request constraints, including server-derived actor and organization fields.
- Documented source-scoped individual reads plus deterministic JSON and JSONL
  exports.
- Documented evaluator-v1 supported call kinds, output-shape validation,
  deterministic one-to-one matching, normalized exact text, the 0.60 word-set
  partial threshold, outcomes, and exact score limits.
- Documented fingerprint comparison requirements, observed versus consistent
  gains, and the cost of the conservative evaluator decision.
- Documented operator-only organization grant provisioning and the existing
  extraction batch pause/resume journal behaviour in isolated copies.
- Reviewed the KAN-34 diff against the plan and KAN-4 boundary: source/copy
  isolation, evaluator-only gold access, append-only repeat records,
  experiment evaluation context, source-scoped authorization, export shape,
  and copy-local pipeline recovery are all represented by the implementation
  and covered by the passing suite. No verification blocker required a code
  correction.

## Files changed

- `docs/kan-34-experiments.md`
- `.superpowers/sdd/2026-10-01-kan34-isolated-gold-experiments/task-6-report.md`

## Tests added

No test was added because this task adds operator documentation and no runtime
behaviour. The existing KAN-34 test suites cover the documented API, evaluator,
copy, pipeline, record, and organization-grant behaviour.

## Verification

- `npx vitest run --silent --maxWorkers=2` — passed: 71 test files, 589 tests,
  68.61 seconds. The local PostgreSQL-backed suite required execution outside
  the filesystem sandbox.
- `npm run typecheck` — passed (`next typegen && tsc --noEmit`).
- `npx eslint docs/kan-34-experiments.md` — exited 0; ESLint reported one
  configuration warning that Markdown is ignored because no matching ESLint
  configuration exists, with zero lint errors.
- `git diff --check` — passed.
- `git diff --check e196939..HEAD` — passed for the complete KAN-34 range.

## Unresolved risks

- Evaluator-v1 intentionally treats paraphrases conservatively. A semantically
  correct paraphrase may be partial or missed until a separately versioned,
  reviewed evaluator is introduced.
- The current authorization model uses subject-to-organization grants and
  source-workspace lineage. More granular per-user workspace permissions would
  require a separate data model and authorization design.
- This task did not publish branches or update Jira, per controller direction.
